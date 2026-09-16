const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Inicjalizacja bazy danych SQLite
const db = new sqlite3.Database('./baza.db', (err) => {
    if (err) {
        console.error('Błąd otwierania bazy danych:', err.message);
    } else {
        console.log('Połączono z bazą danych SQLite.');
        db.run(`CREATE TABLE IF NOT EXISTS workers (
            id TEXT PRIMARY KEY,
            name TEXT,
            lat REAL,
            lng REAL,
            totalDistance REAL,
            history TEXT,
            time TEXT
        )`);
    }
});

app.use(express.static('public'));

// Obliczanie dystansu w km (Haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Wysyłanie aktualnych pozycji i historii z bazy danych do mapy
function sendAllWorkers(socketOrIo) {
    db.all(`SELECT * FROM workers`, [], (err, rows) => {
        if (err) {
            console.error("Błąd pobierania z bazy:", err);
            return;
        }
        let workersLocations = {};
        rows.forEach(row => {
            workersLocations[row.id] = {
                id: row.id,
                name: row.name,
                lat: row.lat,
                lng: row.lng,
                totalDistance: row.totalDistance || 0,
                history: JSON.parse(row.history || '[]'),
                time: row.time
            };
        });
        socketOrIo.emit('updateMap', workersLocations);
    });
}

// OBSŁUGA POŁĄCZEŃ SOCKET.IO (Telefon + Mapa Admina)
io.on('connection', (socket) => {
    console.log('Połączono klienta Socket.io:', socket.id);
    
    // Wysyłamy istniejące dane zaraz po połączeniu
    sendAllWorkers(socket);

    // Odbieranie współrzędnych wysyłanych z phone.html
    socket.on('updateLocation', (data) => {
        const { name, lat, lng } = data;
        const id = name || socket.id; 
        const parsedLat = parseFloat(lat);
        const parsedLng = parseFloat(lng);
        const currentTime = new Date().toISOString();

        if (!id || isNaN(parsedLat) || isNaN(parsedLng)) return;

        db.get(`SELECT * FROM workers WHERE id = ?`, [id], (err, row) => {
            let history = [];
            let totalDistance = 0;
            let workerName = name || `Pracownik ${id}`;

            if (row) {
                workerName = name || row.name;
                try {
                    history = JSON.parse(row.history || '[]');
                } catch(e) { history = []; }
                totalDistance = row.totalDistance || 0;

                if (history.length > 0) {
                    const lastPoint = history[history.length - 1];
                    const dist = calculateDistance(lastPoint[0], lastPoint[1], parsedLat, parsedLng);
                    if (dist > 0.002) { // Zapisujemy przesunięcia powyżej 2 metrów
                        totalDistance += dist;
                    }
                }
            }

            history.push([parsedLat, parsedLng]);

            db.run(`INSERT INTO workers (id, name, lat, lng, totalDistance, history, time) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET 
                    name = excluded.name,
                    lat = excluded.lat,
                    lng = excluded.lng,
                    totalDistance = excluded.totalDistance,
                    history = excluded.history,
                    time = excluded.time`,
                [id, workerName, parsedLat, parsedLng, totalDistance, JSON.stringify(history), currentTime],
                (err) => {
                    if (err) {
                        console.error("Błąd zapisu do bazy:", err);
                        return;
                    }
                    // Rozsyłamy odświeżone dane do wszystkich otwartych map
                    sendAllWorkers(io);
                }
            );
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serwer działa na porcie ${PORT}`);
});