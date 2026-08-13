/**
 * server.js
 * Entry point — API Node.js para BANDRAK
 * 
 * Express + WebSocket + Firebase Admin SDK
 * - Credenciales Firebase NUNCA expuestas al frontend
 * - Rate limiting anti-DDoS en memoria
 * - WebSocket para notificaciones en tiempo real
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

// ── Servicios ─────────────────────────────────────────────────────────────────
const firebase = require('./services/firebaseService');
const { rateLimiterMiddleware, extractIPMiddleware } = require('./middleware/rateLimiter');
const wsManager = require('./websocket/wsManager');

// ── Rutas ─────────────────────────────────────────────────────────────────────
const publicRoutes = require('./routes/publicRoutes');
const panelRoutes = require('./routes/panelRoutes');

// ── App Express ───────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ── Middleware global ─────────────────────────────────────────────────────────

// Seguridad HTTP headers
app.use(helmet({
  contentSecurityPolicy: false, // Desactivar CSP para permitir recursos del frontend
  crossOriginEmbedderPolicy: false
}));

// CORS
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({
  origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Panel-Token'],
  credentials: true
}));

// Parser JSON
app.use(express.json({ limit: '1mb' }));

// No cache para API
app.use('/api', (req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': 'Thu, 01 Jan 1970 00:00:00 GMT'
  });
  next();
});

// ── Archivos estáticos (frontend) ─────────────────────────────────────────────
// Servir el frontend desde la carpeta padre (bandrak2/)
app.use(express.static(path.join(__dirname, '..')));

// ── Rutas ─────────────────────────────────────────────────────────────────────

// Rutas del panel PRIMERO: sin rate limiting, solo extracción de IP
// (DEBE ir antes de /api para que Express no pase por el rate limiter)
app.use('/api/panel', extractIPMiddleware, panelRoutes);

// Rutas públicas: solo extracción de IP (rate limiting es manual via botón BLOQUEAR)
app.use('/api', extractIPMiddleware, publicRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const stats = wsManager.getStats();
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    websocket: stats
  });
});

// ── 404 para rutas API no encontradas ─────────────────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({ ok: false, error: 'Ruta no encontrada' });
});

// ── Inicializar WebSocket ─────────────────────────────────────────────────────
wsManager.initWebSocket(server);

// ── Iniciar Firestore listener → WebSocket bridge ─────────────────────────────
firebase.startCollectionListener((clienteid, data, changeType) => {
  // Cuando Firestore detecta un cambio, notificar vía WebSocket
  wsManager.onFirestoreChange(clienteid, data, changeType);
});

// ── Iniciar servidor ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;

server.listen(PORT, () => {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  🚀 BANDRAK API Server corriendo en http://localhost:${PORT}`);
  console.log(`  🔌 WebSocket disponible en ws://localhost:${PORT}/ws`);
  console.log(`  📁 Frontend servido desde: ${path.join(__dirname, '..')}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
});
