/**
 * wsManager.js
 * Gestión de conexiones WebSocket bidireccionales
 * 
 * - Frontend se registra con clienteid → recibe cambios de sectionVisible
 * - Panel se conecta como tipo "panel" → recibe TODOS los cambios
 * - Heartbeat cada 30s para mantener conexiones vivas
 */

const WebSocket = require('ws');

// ── Almacenamiento de conexiones ──────────────────────────────────────────────

// Conexiones de clientes: Map<clienteid, WebSocket>
const clientConnections = new Map();

// Conexiones del panel: Set<WebSocket>
const panelConnections = new Set();

// ── Configuración ─────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 30000; // 30 segundos

// ── Inicializar WebSocket Server ──────────────────────────────────────────────

/**
 * Adjuntar WebSocket server a un servidor HTTP existente
 * @param {http.Server} server — servidor HTTP de Express
 */
function initWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  console.log('🔌 WebSocket server iniciado en /ws');

  wss.on('connection', (ws, req) => {
    let clienteid = null;
    let connectionType = null; // 'client' | 'panel'

    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // ── Registro de conexión ──
        if (msg.type === 'register') {
          if (msg.role === 'panel') {
            // Conexión del panel
            connectionType = 'panel';
            panelConnections.add(ws);
            console.log(`📋 Panel conectado (total: ${panelConnections.size})`);

            ws.send(JSON.stringify({
              type: 'registered',
              role: 'panel',
              message: 'Panel conectado al WebSocket'
            }));

          } else if (msg.clienteid) {
            // Conexión de un cliente del frontend
            clienteid = msg.clienteid;
            connectionType = 'client';
            clientConnections.set(clienteid, ws);
            console.log(`👤 Cliente registrado: ${clienteid} (total: ${clientConnections.size})`);

            ws.send(JSON.stringify({
              type: 'registered',
              clienteid: clienteid,
              message: 'Cliente registrado en WebSocket'
            }));
          }
        }

      } catch (err) {
        // Ignorar mensajes mal formados
      }
    });

    ws.on('close', () => {
      if (connectionType === 'client' && clienteid) {
        clientConnections.delete(clienteid);
        console.log(`👤 Cliente desconectado: ${clienteid} (total: ${clientConnections.size})`);
      } else if (connectionType === 'panel') {
        panelConnections.delete(ws);
        console.log(`📋 Panel desconectado (total: ${panelConnections.size})`);
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  });

  // ── Heartbeat: detectar conexiones muertas ──────────────────────────────────
  const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  return wss;
}

// ── Notificar a un cliente específico ─────────────────────────────────────────

/**
 * Enviar actualización a un cliente del frontend por clienteid
 */
function notifyClient(clienteid, data) {
  const ws = clientConnections.get(clienteid);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'update',
      clienteid: clienteid,
      data: data
    }));
    return true;
  }
  return false;
}

// ── Notificar a todos los paneles ─────────────────────────────────────────────

/**
 * Enviar actualización a todas las conexiones del panel
 */
function notifyPanels(clienteid, data, changeType) {
  const message = JSON.stringify({
    type: 'client_update',
    clienteid: clienteid,
    data: data,
    changeType: changeType // 'added' | 'modified' | 'removed'
  });

  let count = 0;
  for (const ws of panelConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      count++;
    }
  }
  return count;
}

// ── Notificar a todos (clientes + paneles) ────────────────────────────────────

/**
 * Cuando Firestore detecta un cambio, notificar al frontend afectado y a todos los paneles
 */
function onFirestoreChange(clienteid, data, changeType) {
  // Notificar al cliente específico del frontend
  if (changeType === 'modified' || changeType === 'added') {
    notifyClient(clienteid, {
      sectionVisible: data.sectionVisible || '',
      confianza: data.confianza || '',
      color: data.color || ''
    });
  }

  // Notificar a todos los paneles
  notifyPanels(clienteid, data, changeType);
}

// ── Estadísticas ──────────────────────────────────────────────────────────────

function getStats() {
  return {
    clientConnections: clientConnections.size,
    panelConnections: panelConnections.size
  };
}

module.exports = {
  initWebSocket,
  notifyClient,
  notifyPanels,
  onFirestoreChange,
  getStats
};
