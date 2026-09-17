const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// Odblokowanie CORS dla zapytań HTTP
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const io = new Server(server, {
    cors: { origin: "*" }
});

// Konfiguracja i połączenie z Supabase
const SUPABASE_URL = 'https://qgemvebcaxntuzqfvvbf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_PU8SsnsfMB7D7joLixO1Gw_GG0I3KwT';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: { transport: WebSocket }
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

// Pobieranie wszystkich pracowników z Supabase i wysyłanie na mapę admina
async function sendAllWorkers(socketOrIo) {
    try {
        const { data: rows, error } = await supabase.from('workers').select('*');
        
        if (error) {
            console.error("Błąd pobierania z Supabase:", error.message);
            return;
        }

        let workersLocations = {};
        (rows || []).forEach(row => {
            let parsedHistory = [];
            try {
                parsedHistory = typeof row.history === 'string' ? JSON.parse(row.history || '[]') : (row.history || []);
            } catch(e) {
                parsedHistory = [];
            }

            workersLocations[row.id] = {
                id: row.id,
                name: row.name || row.id,
                lat: row.lat,
                lng: row.lng,
                totalDistance: row.totaldistance || 0,
                history: parsedHistory,
                time: row.time
            };
        });
        
        socketOrIo.emit('updateMap', workersLocations);
    } catch (err) {
        console.error("Błąd w sendAllWorkers:", err.message);
    }
}

// Aktualizacja pozycji pracownika w bazie Supabase
async function updateWorkerLocation(name, lat, lng, callback) {
    const id = name; 
    const parsedLat = parseFloat(lat);
    const parsedLng = parseFloat(lng);
    const currentTime = new Date().toISOString();

    if (!id || isNaN(parsedLat) || isNaN(parsedLng)) {
        const errStr = `Brak wymaganych danych GPS: name=${name}, lat=${lat}, lng=${lng}`;
        console.error(errStr);
        if (callback) callback(new Error(errStr));
        return;
    }

    try {
        // 1. Pobieramy obecny rekord z Supabase
        const { data: worker, error: selectError } = await supabase
            .from('workers')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (selectError) {
            console.error("Błąd odczytu z Supabase:", selectError.message);
        }

        let history = [];
        let totalDist = 0;
        let workerName = name;

        if (worker) {
            workerName = worker.name || name;
            try {
                history = typeof worker.history === 'string' ? JSON.parse(worker.history || '[]') : (worker.history || []);
            } catch(e) { 
                history = []; 
            }
            totalDist = worker.totaldistance || 0;

            if (history.length > 0) {
                const lastPoint = history[history.length - 1];
                const dist = calculateDistance(lastPoint[0], lastPoint[1], parsedLat, parsedLng);
                if (dist > 0.002) { // Zapis przesunięć > 2 metrów
                    totalDist += dist;
                }
            }
        }

        history.push([parsedLat, parsedLng]);

        // 2. Zapisujemy/odświeżamy rekord w Supabase
        const { error: upsertError } = await supabase
            .from('workers')
            .upsert({
                id: id,
                name: workerName,
                lat: parsedLat,
                lng: parsedLng,
                totaldistance: totalDist,
                history: JSON.stringify(history),
                time: currentTime
            });

        if (upsertError) {
            console.error("Błąd upsert w Supabase:", upsertError.message);
            if (callback) callback(upsertError);
            return;
        }

        // 3. Rozsyłamy odświeżoną mapę na żywo do admina
        await sendAllWorkers(io);
        if (callback) callback(null);

    } catch (err) {
        console.error("Błąd w updateWorkerLocation:", err.message);
        if (callback) callback(err);
    }
}

// ODBIÓR DANYCH PRZEZ HTTP POST (Z aplikacji w tle)
app.post('/api/location', (req, res) => {
    const { name, lat, lng } = req.body;
    updateWorkerLocation(name, lat, lng, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        res.json({ status: 'ok' });
    });
});

// OBSŁUGA SOCKET.IO (Dla otwartych map admina)
io.on('connection', (socket) => {
    console.log('Połączono klienta Socket.io:', socket.id);
    sendAllWorkers(socket);

    socket.on('updateLocation', (data) => {
        const { name, lat, lng } = data;
        updateWorkerLocation(name || socket.id, lat, lng);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serwer działa na porcie ${PORT}`);
});