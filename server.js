const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Inicjalizacja bazy danych SQLite (plik baza.db utworzy się automatycznie)
const db = new sqlite3.Database('./baza.db', (err) => {
    if (err) {
        console.error('Błąd otwierania bazy danych', err.message);
    } else {
        console.log('Połączono z bazą danych SQLite.');
        // Tworzymy tabelę na dane pracowników, jeśli nie istnieje
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

// Funkcja do obliczania dystansu między dwoma punktami GPS (wzór Haversine) in km
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Promień Ziemi w km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Pomocnicza funkcja do pobrania wszystkich pracowników z bazy i wysłania do taty
function sendAllWorkers(socketOrIo) {
    db.all(`SELECT * FROM workers`, [], (err, rows) => {
        if (err) {
            console.error(err);
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

// Odbieranie pozycji z telefonu pracownika
app.get('/update', (req, res) => {
    const { id, name, lat, lng } = req.query;
    if (id && lat && lng) {
        const parsedLat = parseFloat(lat);
        const parsedLng = parseFloat(lng);
        const currentTime = new Date().toISOString();

        // Pobieramy aktualny stan pracownika z bazy, żeby obliczyć dystans i historię
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

                // Jeśli mamy poprzedni punkt, liczymy odległość
                if (history.length > 0) {
                    const lastPoint = history[history.length - 1];
                    const dist = calculateDistance(lastPoint[0], lastPoint[1], parsedLat, parsedLng);
                    // Dodajemy tylko jeśli przesunął się o więcej niż 2 metry (eliminacja drgań GPS w miejscu)
                    if (dist > 0.002) {
                        totalDistance += dist;
                    }
                }
            }

            // Dodajemy nowy punkt do historii
            history.push([parsedLat, parsedLng]);

            // Zapisujemy lub aktualizujemy w bazie danych
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
                        return res.status(500).send({ error: "Błąd bazy danych" });
                    }

                    // Wysyłamy zaktualizowane dane do taty przez WebSocket
                    sendAllWorkers(io);
                    res.send({ status: "OK", totalDistance: totalDistance.toFixed(2) });
                }
            );
        });
    } else {
        res.status(400).send({ error: "Brak danych (id, lat, lng)" });
    }
});

io.on('connection', (socket) => {
    console.log('Tata otworzył panel mapy.');
    // Wysyłamy pełną historię i dane z bazy, gdy tata wchodzi na stronę
    sendAllWorkers(socket);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serwer działa na porcie ${PORT}`);
});
