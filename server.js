const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Włączamy obsługę przesyłania danych w formacie JSON (dla HTTP POST)
app.use(express.json());
app.use(express.static('public'));

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

// Główna funkcja zapisująca pozycję w bazie i przeliczająca dystans
function updateWorkerLocation(name, lat, lng, callback) {
    const id = name; 
    const parsedLat = parseFloat(lat);
    const parsedLng = parseFloat(lng);
    const currentTime = new Date().toISOString();

    if (!id || isNaN(parsedLat) || isNaN(parsedLng)) {
        if (callback) callback(new Error("Brak wymaganych danych GPS"));
        return;
    }

    db.get(`SELECT * FROM workers WHERE id = ?`, [id], (err, row) => {
        let history = [];
        let totalDistance = 0;
        let workerName = name;

        if (row) {
            workerName = row.name || name;
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
                    if (callback) callback(err);
                    return;
                }
                // Rozsyłamy odświeżone dane do wszystkich otwartych map (Socket.io)
                sendAllWorkers(io);
                if (callback) callback(null);
            }
        );
    });
}

// 1. ODBIÓR DANYCH PRZEZ HTTP POST (Z aplikacji w tle)
app.post('/api/location', (req, res) => {
    const { name, lat, lng } = req.body;
    updateWorkerLocation(name, lat, lng, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        res.json({ status: 'ok' });
    });
});

// 2. OBSŁUGA POŁĄCZEŃ SOCKET.IO (Do wysyłania danych na mapę admina)
io.on('connection', (socket) => {
    console.log('Połączono klienta Socket.io:', socket.id);
    
    // Wysyłamy istniejące dane zaraz po połączeniu mapy
    sendAllWorkers(socket);

    // Awaryjna obsługa dla połączeń Socket.io
    socket.on('updateLocation', (data) => {
        const { name, lat, lng } = data;
        updateWorkerLocation(name || socket.id, lat, lng);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serwer działa na porcie ${PORT}`);
});