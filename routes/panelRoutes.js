/**
 * panelRoutes.js
 * Endpoints protegidos del panel de control
 * Todas las rutas requieren X-Panel-Token (validado por middleware)
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const firebase = require('../services/firebaseService');
const rateLimiter = require('../middleware/rateLimiter');

// ── Middleware: verificar token del panel ──────────────────────────────────────
function requirePanelToken(req, res, next) {
  const tokenHeader = req.headers['x-panel-token'] || '';
  const tokenBody = req.body?.panel_token || '';
  const token = tokenHeader || tokenBody;

  const expectedToken = process.env.PANEL_TOKEN || '';
  if (!expectedToken) {
    return res.status(500).json({ ok: false, error: 'Token no configurado en el servidor' });
  }

  // Comparación de tiempo constante para evitar timing attacks
  const tokenBuffer = Buffer.from(token || '');
  const expectedBuffer = Buffer.from(expectedToken);

  if (tokenBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(tokenBuffer, expectedBuffer)) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  next();
}

// ── POST /api/panel/login — Validar credenciales ──────────────────────────────
router.post('/login', (req, res) => {
  const { usuario, clave } = req.body || {};
  const expectedUser = process.env.PANEL_USER || '';
  const expectedPass = process.env.PANEL_PASS || '';

  if (!expectedUser || !expectedPass) {
    return res.status(500).json({ ok: false, error: 'Credenciales no configuradas' });
  }

  // Comparación de tiempo constante
  const userMatch = usuario && usuario.length === expectedUser.length
    && crypto.timingSafeEqual(Buffer.from(usuario), Buffer.from(expectedUser));
  const passMatch = clave && clave.length === expectedPass.length
    && crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(expectedPass));

  if (userMatch && passMatch) {
    res.json({ ok: true, token: process.env.PANEL_TOKEN });
  } else {
    res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
  }
});

// ── Todas las siguientes rutas requieren token ────────────────────────────────
router.use(requirePanelToken);

// ── GET /api/panel/clients — Obtener todos los clientes ───────────────────────
router.get('/clients', async (req, res) => {
  try {
    const clientes = await firebase.getAllClientes();
    res.json({ ok: true, clientes });
  } catch (err) {
    console.error('Error en GET /api/panel/clients:', err.message);
    res.json({ ok: false, error: 'Error al consultar' });
  }
});

// ── DELETE /api/panel/client/:id — Eliminar un cliente ────────────────────────
router.delete('/client/:id', async (req, res) => {
  try {
    const clienteid = req.params.id;
    if (!clienteid) {
      return res.json({ ok: false, error: 'clienteid requerido' });
    }
    await firebase.deleteCliente(clienteid);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/panel/client:', err.message);
    res.json({ ok: false, error: 'Error al eliminar' });
  }
});

// ── DELETE /api/panel/clients — Eliminar todos los clientes ───────────────────
router.delete('/clients', async (req, res) => {
  try {
    await firebase.deleteAllClientes();
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/panel/clients:', err.message);
    res.json({ ok: false, error: 'Error al eliminar' });
  }
});

// ── POST /api/panel/set-data — Cambiar datos de un cliente desde el panel ─────
router.post('/set-data', async (req, res) => {
  try {
    const body = req.body || {};
    const clienteid = body.clienteid;

    if (!clienteid) {
      return res.json({ ok: false, error: 'clienteid requerido' });
    }

    await firebase.setCliente(clienteid, body);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error en POST /api/panel/set-data:', err.message);
    res.json({ ok: false, error: 'Error al guardar' });
  }
});

// ── POST /api/panel/block-ip — Bloquear una IP ───────────────────────────────
router.post('/block-ip', async (req, res) => {
  try {
    const ip = (req.body.ip || '').trim();
    if (!ip) {
      return res.json({ ok: false, error: 'IP requerida' });
    }

    const duration = parseInt(req.body.duration) || 0; // 0 = permanente

    // Bloquear en memoria
    rateLimiter.addToBlacklist(ip, duration > 0 ? duration * 1000 : 0);

    // Persistir en Firestore
    await firebase.saveBlockedIP(ip, duration);

    res.json({
      ok: true,
      blocked: ip,
      duration: duration === 0 ? 'permanente' : duration + 's'
    });
  } catch (err) {
    console.error('Error en POST /api/panel/block-ip:', err.message);
    res.json({ ok: false, error: 'Error al bloquear' });
  }
});

// ── POST /api/panel/unblock-ip — Desbloquear una IP ──────────────────────────
router.post('/unblock-ip', async (req, res) => {
  try {
    const ip = (req.body.ip || '').trim();
    if (!ip) {
      return res.json({ ok: false, error: 'IP requerida' });
    }

    // Remover de memoria
    rateLimiter.removeFromBlacklist(ip);

    // Remover de Firestore
    await firebase.removeBlockedIP(ip);

    res.json({ ok: true, unblocked: ip });
  } catch (err) {
    console.error('Error en POST /api/panel/unblock-ip:', err.message);
    res.json({ ok: false, error: 'Error al desbloquear' });
  }
});

// ── GET /api/panel/blocked-ips — Listar IPs bloqueadas ────────────────────────
router.get('/blocked-ips', async (req, res) => {
  try {
    // Combinar IPs de memoria + Firestore
    const memoryIPs = rateLimiter.getBlacklistedIPs();
    let firestoreIPs = [];
    try {
      firestoreIPs = await firebase.getBlockedIPs();
    } catch (e) {
      // Si Firestore falla, usar solo memoria
    }

    // Merge: usar memoria como fuente primaria, Firestore como backup
    const merged = new Map();
    for (const entry of memoryIPs) {
      merged.set(entry.ip, entry);
    }
    for (const entry of firestoreIPs) {
      if (!merged.has(entry.ip)) {
        merged.set(entry.ip, entry);
      }
    }

    res.json({ ok: true, blocked_ips: Array.from(merged.values()) });
  } catch (err) {
    console.error('Error en GET /api/panel/blocked-ips:', err.message);
    res.json({ ok: false, error: 'Error al consultar' });
  }
});

module.exports = router;
