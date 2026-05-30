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

// ── CONFIGURACIÓN DE PARSERS Y MIDDLEWARES DE ADMIN ─────────────────────────
app.use(express.json({ limit: '500kb' }));

// ── ENDPOINT PUENTE SEGURO: Evita el error 404 procesando el Token en las Cabeceras ──
app.post('/admin/generar-ia', async (req, res) => {
    try {
        const { tema } = req.body;
        if (!tema) {
            return res.status(400).json({ ok: false, error: 'Falta especificar el tema de la trivia.' });
        }

        const promptFinal = `Generá exactamente 50 preguntas de trivia en español sobre el tema: "${tema}".
Cada pregunta debe tener 1 respuesta correcta y 3 incorrectas.
Respondé ÚNICAMENTE con un array JSON válido, sin texto adicional, sin bloques de código markdown, sin explicaciones.
El formato de cada elemento debe ser exactamente:
{"id": N, "pregunta": "...", "correcta": "...", "incorrectas": ["...", "...", "..."]}
Numerá del 1 al 50. Las respuestas deben ser concisas (máximo 8 palabras). Las preguntas deben ser variadas y de dificultad progresiva.`;

        // Tu token real de Google Cloud
        const GOOGLE_CLOUD_TOKEN = "AQ.Ab8RN6IgEmkCWCBiuEaonDHczZw0a5MJGQ65J0dsyOXXxC6-Yw"; 
        
        // URL limpia sin "?key=" (El endpoint requiere autenticación Bearer)
        const urlApi = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`;

        const response = await fetch(urlApi, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GOOGLE_CLOUD_TOKEN}`
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: promptFinal }] }]
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Google API respondió con código status ${response.status}. Detalles: ${errorBody}`);
        }

        const dataJson = await response.json();
        
        if (!dataJson.candidates || !dataJson.candidates[0] || !dataJson.candidates[0].content) {
            throw new Error("La IA de Google devolvió una estructura de datos vacía o inválida.");
        }

        let responseText = dataJson.candidates[0].content.parts[0].text.trim();

        // Limpieza quirúrgica de bloques de código markdown añadidos por inercia por el modelo
        if (responseText.startsWith("```")) {
            responseText = responseText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
        }

        const preguntasValidadas = JSON.parse(responseText);
        return res.json({ ok: true, preguntas: preguntasValidadas });

    } catch (err) {
        console.error("❌ Error en puente de IA interno:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── ENDPOINT ADMIN: Cambiar tema guardando directamente en MongoDB ──────────────────────────
app.post('/admin/cambiar-tema', async (req, res) => {
    try {
        const { preguntas, evento_nombre, evento_subtitulo, url_publica } = req.body;

        if (!preguntas || !Array.isArray(preguntas) || preguntas.length < 10) {
            return res.status(400).json({ ok: false, error: 'Se necesitan al menos 10 preguntas.' });
        }
        if (!evento_nombre || !url_publica) {
            return res.status(400).json({ ok: false, error: 'Faltan nombre del evento o URL.' });
        }

        if (dbPreguntas && dbConfig) {
            // 1. Limpiar preguntas anteriores e insertar las nuevas en
