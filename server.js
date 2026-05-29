const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb'); 

const app = express();
const server = http.createServer(app);

// ── CONFIGURACIÓN DE SOCKET.IO PARA PRODUCCIÓN (RENDER) ────────────────
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    },
    transports: ['polling', 'websocket'] 
});

app.use(express.static('public'));

// Variables globales de configuración y estado en memoria
let contenido = null;
let preguntasTodo = [];
let jugadores = {}; 

const CONTENIDO_PATH = path.join(__dirname, 'contenido.json');
const PREGUNTAS_PATH = path.join(__dirname, 'preguntas.json');

// Cargar respaldos locales iniciales por seguridad
try {
    contenido = JSON.parse(fs.readFileSync(CONTENIDO_PATH, 'utf8'));
    preguntasTodo = JSON.parse(fs.readFileSync(PREGUNTAS_PATH, 'utf8'));
} catch (err) {
    console.error("⚠️ Error cargando archivos JSON locales de respaldo:", err.message);
}

const mongoUri = process.env.MONGO_URI; 
let dbCollection = null;     // Colección de jugadores
let dbPreguntas = null;      // Nueva colección para preguntas
let dbConfig = null;         // Nueva colección para textos/config del evento

async function conectarBaseDeDatos() {
    if (!mongoUri) {
        console.log("⚠️ ALERTA: No se detectó MONGO_URI. Funcionando en memoria de forma efímera.");
        return;
    }
    try {
        const client = new MongoClient(mongoUri);
        await client.connect();
        
        // Base de datos principal tomada del archivo de configuración inicial
        const db = client.db(contenido.config.mongo_db);       
        
        dbCollection = db.collection(contenido.config.mongo_col); 
        dbPreguntas = db.collection("preguntas_trivia");
        dbConfig = db.collection("config_trivia");
        
        console.log("🚀 CONECTADO EXITOSAMENTE A MONGO DB ATLAS");

        // 1. Cargar Configuración Dinámica del Evento desde la Nube
        const configNube = await dbConfig.findOne({ tipo: "contenido_actual" });
        if (configNube) {
            contenido = configNube.datos;
            console.log(`📋 Configuración cargada desde la Nube: ${contenido.evento.nombre}`);
        } else {
            console.log(`📋 Usando configuración local por defecto: ${contenido.evento.nombre}`);
        }

        // 2. Cargar Preguntas Dinámicas desde la Nube
        const preguntasNube = await dbPreguntas.find({}).toArray();
        if (preguntasNube.length > 0) {
            preguntasTodo = preguntasNube.map(p => ({
                id: p.id,
                pregunta: p.pregunta,
                correcta: p.correcta,
                incorrectas: p.incorrectas
            }));
            console.log(`📦 Preguntas sincronizadas desde la Nube: ${preguntasTodo.length}`);
        } else {
            console.log(`📦 Usando preguntas locales por defecto: ${preguntasTodo.length}`);
        }

        // 3. Recuperar Historial de Jugadores
        const historialNube = await dbCollection.find({}).toArray();
        historialNube.forEach(jugador => {
            if (jugador.puntos === undefined) jugador.puntos = 0;
            if (jugador.puntosRondaActual === undefined) jugador.puntosRondaActual = 0;
            if (!jugador.respondidas) jugador.respondidas = [];
            
            jugadores[jugador.username] = jugador;
        });
        console.log(`👥 Usuarios recuperados desde la nube: ${Object.keys(jugadores).length}`);
        
        // Iniciar el sistema de Auto-Ping una vez obtenida la URL pública de forma segura
        activarKeepAlive();

    } catch (error) {
        console.error("❌ Error crítico al conectar a MongoDB Atlas:", error.message);
    }
}

conectarBaseDeDatos();

// Guarda o actualiza los datos de un jugador en la nube
async function guardarRankingEnNube(username) {
    if (dbCollection && jugadores[username]) {
        try {
            const datosJugador = { ...jugadores[username] };
            delete datosJugador._id; 
            
            await dbCollection.updateOne(
                { username: username },
                { $set: datosJugador },
                { upsert: true }
            );
        } catch (err) {
            console.log(`❌ Error al sincronizar usuario @${username} con Atlas:`, err.message);
        }
    }
}

// Servir la configuración actualizada (prioriza memoria dinámica)
app.get('/contenido.json', (req, res) => {
    res.json(contenido);
});

// Servir datos curiosos generados dinámicamente desde las preguntas activas
app.get('/datos_curiosos.json', (req, res) => {
    const curiosos = preguntasTodo.map(p => ({
        id: p.id,
        pregunta: p.pregunta,
        dato: p.correcta
    }));
    res.json(curiosos);
});

app.get('/ranking_persistente.json', (req, res) => {
    let listaCompleta = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    res.json(listaCompleta);
});

// ── ENDPOINT ADMIN: Cambiar tema guardando directamente en MongoDB ──────────────────────────
app.use(express.json({ limit: '500kb' }));

app.post('/admin/cambiar-tema', async (req, res) => {
    try {
        const { preguntas, evento_nombre, evento_subtitulo, url_publica } = req.body;

        if (!preguntas || !Array.isArray(preguntas) || preguntas.length < 10) {
            return res.status(400).json({ ok: false, error: 'Se necesitan al menos 10 preguntas.' });
        }
        if (!evento_nombre || !url_publica) {
            return res.status(400).json({ ok: false, error: 'Faltan nombre del evento o URL.' });
        }

        // Si la base de datos está disponible, persistimos en la nube
        if (dbPreguntas && dbConfig) {
            // 1. Limpiar preguntas anteriores e insertar las nuevas en MongoDB
            await dbPreguntas.deleteMany({});
            await dbPreguntas.insertMany(preguntas);

            // 2. Estructurar el nuevo contenido de textos del evento
            contenido.config.url_publica           = url_publica;
            contenido.evento.nombre                = evento_nombre;
            contenido.evento.subtitulo             = evento_subtitulo || evento_nombre;
            contenido.login.titulo                 = '¡' + evento_nombre + '!';
            contenido.leaderboard.titulo_principal = evento_nombre;
            contenido.resultados.url_reinicio       = url_publica;

            // 3. Guardar configuración estructurada en MongoDB
            await dbConfig.updateOne(
                { tipo: "contenido_actual" },
                { $set: { tipo: "contenido_actual", datos: contenido } },
                { upsert: true }
            );

            // 4. Actualizar las variables en tiempo real en la memoria del proceso
            preguntasTodo = preguntas;

            console.log(`🔄 TEMA ACTUALIZADO EN MONGO ATLAS: "${evento_nombre}" | ${preguntas.length} preguntas.`);
            
            res.json({
                ok: true,
                mensaje: `Tema "${evento_nombre}" aplicado y guardado en la nube con éxito.`,
                preguntas_total: preguntas.length
            });
        } else {
            res.status(500).json({ ok: false, error: "La base de datos de MongoDB no está inicializada." });
        }

    } catch (err) {
        console.error('❌ Error al cambiar tema en la nube:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// LOGICA CENTRAL DE COMUNICACIÓN EN VIVO (WebSockets)
io.on('connection', (socket) => {
    console.log('🔌 Nuevo cliente conectado:', socket.id);

    let listaAlConectar = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    socket.emit('update_ranking', listaAlConectar);

    socket.on('pedir_ranking_dashboard', () => {
        let listaCompleta = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
        socket.emit('data_ranking_dashboard', listaCompleta);
    });

    socket.on('join_game', (username) => {
        const cleanUsername = username.toLowerCase().replace('@', '').trim();
        
        if (jugadores[cleanUsername]) {
            jugadores[cleanUsername].vidas = 3;
            jugadores[cleanUsername].respondidas = [];
            jugadores[cleanUsername].combo = 0;
            jugadores[cleanUsername].puntosRondaActual = 0; 
            jugadores[cleanUsername].socketId = socket.id;
        } else {
            jugadores[cleanUsername] = {
                username: cleanUsername,
                puntos: 0, 
                puntosRondaActual: 0, 
                vidas: 3,
                respondidas: [],
                combo: 0,
                socketId: socket.id
            };
        }
        
        socket.usernameClean = cleanUsername;
        guardarRankingEnNube(cleanUsername); 
        enviarRankingAClientes();
    });

    socket.on('get_pregunta', () => {
        const cleanUsername = socket.usernameClean;
        const jugador = jugadores[cleanUsername];
        if (!jugador) return;

        if (jugador.vidas <= 0 || jugador.respondidas.length >= 10) {
            const puesto = obtenerPuesto(cleanUsername);
            socket.emit(jugador.vidas <= 0 ? 'game_over' : 'game_completed', { puntos: jugador.puntosRondaActual, puesto: puesto });
            return;
        }

        const disponibles = preguntasTodo.filter(p => !jugador.respondidas.includes(p.id));
        if (disponibles.length === 0) {
            const puesto = obtenerPuesto(cleanUsername);
            socket.emit('game_completed', { puntos: jugador.puntosRondaActual, puesto: puesto });
            return;
        }

        const pregunta = disponibles[Math.floor(Math.random() * disponibles.length)];
        const opciones = [pregunta.correcta, ...pregunta.incorrectas].sort(() => Math.random() - 0.5);

        socket.emit('pregunta_data', {
            id: pregunta.id,
            pregunta: pregunta.pregunta,
            opciones: opciones,
            numeroPregunta: jugador.respondidas.length + 1
        });
    });

    socket.on('enviar_respuesta', ({ preguntaId, respuesta, intento, tiempoEmpleado }) => {
        const cleanUsername = socket.usernameClean;
        const jugador = jugadores[cleanUsername];
        if (!jugador) return;

        if (respuesta === "__TIEMPO_AGOTADO__") {
            jugador.respondidas.push(preguntaId);
            jugador.vidas -= 1;
            jugador.combo = 0; 
            
            socket.emit('resultado_respuesta', { correcta: false, tiempoAgotado: true, intento: 2, vidas: jugador.vidas });
            guardarRankingEnNube(cleanUsername);
            enviarRankingAClientes();
            return;
        }

        const pregunta = preguntasTodo.find(p => p.id === preguntaId);
        if (!pregunta) return;
        
        const esCorrecta = pregunta.correcta === respuesta;

        if (esCorrecta) {
            jugador.respondidas.push(preguntaId);
            jugador.combo += 1;

            let puntosBase = intento === 1 ? 10 : 5;
            let bonusTiempo = Math.max(0, Math.round(15 * Math.log(20 / (tiempoEmpleado + 1))));
            let puntosPregunta = puntosBase + bonusTiempo;

            let multiplicador = 1;
            if (jugador.combo === 3) multiplicador = 2;
            if (jugador.combo === 6) multiplicador = 4;
            if (jugador.combo === 9) multiplicador = 6;

            jugador.puntosRondaActual += puntosPregunta * multiplicador;

            if (jugador.puntosRondaActual > jugador.puntos) {
                jugador.puntos = jugador.puntosRondaActual;
            }

            socket.emit('resultado_respuesta', { correcta: true, puntos: jugador.puntosRondaActual, combo: jugador.combo });
        } else {
            if (intento === 1) {
                socket.emit('resultado_respuesta', { correcta: false, intento: 1 });
            } else {
                jugador.respondidas.push(preguntaId);
                jugador.vidas -= 1;
                jugador.combo = 0;
                socket.emit('resultado_respuesta', { correcta: false, intento: 2, vidas: jugador.vidas });
            }
        }
        
        guardarRankingEnNube(cleanUsername); 
        enviarRankingAClientes();
    });

    socket.on('reset_game', () => {
        const cleanUsername = socket.usernameClean;
        if (cleanUsername && jugadores[cleanUsername]) {
            jugadores[cleanUsername].vidas = 3;
            jugadores[cleanUsername].respondidas = [];
            jugadores[cleanUsername].combo = 0;
            jugadores[cleanUsername].puntosRondaActual = 0;
            
            guardarRankingEnNube(cleanUsername);
            enviarRankingAClientes();
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 Usuario desconectado:', socket.id);
    });
});

function obtenerPuesto(username) {
    let listaOrdenada = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    let index = listaOrdenada.findIndex(j => j.username === username);
    return index !== -1 ? index + 1 : listaOrdenada.length;
}

function enviarRankingAClientes() {
    let lista = Object.values(jugadores).sort((a, b) => b.puntos - a.puntos);
    io.emit('update_ranking', lista);
    io.emit('data_ranking_dashboard', lista); 
}

// Función Keep-Alive usando la URL real del evento configurada
function activarKeepAlive() {
    if (contenido && contenido.config && contenido.config.url_publica) {
        const urlPeticion = contenido.config.url_publica;
        setInterval(() => {
            http.get(urlPeticion, (res) => {}).on('error', (err) => {
                console.log("Ping Keep-Alive fallido silenciosamente.");
            });
        }, 300000); // Cada 5 minutos
    }
}

// INICIO DEL SERVIDOR
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor central corriendo en el puerto ${PORT}`);
});
