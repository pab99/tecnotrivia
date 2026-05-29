# Gran Trivia de Mayo 🇦🇷☀️

Proyecto rápido, simple y optimizado para ser desplegado en **Render** con soporte en tiempo real vía WebSockets (`Socket.io`). 

## Características
- **50 Preguntas** históricas sobre la Revolución de Mayo sin repetirse por usuario (se sortean 10 por ronda).
- **Respuestas ordenadas al azar** en cada dispositivo para evitar copias entre vecinos.
- **Teclado virtual integrado** adaptado a caracteres admitidos por Instagram.
- **Sistema de puntajes dinámico**: Puntuación logarítmica según velocidad y multiplicadores por racha/combo (hasta x10).
- **Lógica de vidas**: 3 vidas (con 2do intento permitido a mitad de puntos en cada pregunta).
- **Efectos de sonido arcade nativos** generados mediante la API de Web Audio (sin dependencias de archivos de sonido pesados).
- **Pantalla Gigante Leaderboard**: Tabla de posiciones en tiempo real y rotación automática de curiosidades coloniales.

## Despliegue en Render
1. Subí este repositorio completo a GitHub.
2. Creá un nuevo **Web Service** en Render.
3. Vinculá el repositorio.
4. Configurá el nombre del servicio como `trivia25demayo`.
5. Comandos automáticos:
   - Build: `npm install`
   - Start: `npm start`
