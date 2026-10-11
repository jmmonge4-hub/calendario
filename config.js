// Configuración del calendario. Rellena firebaseConfig para sincronizar entre
// ordenador y móvil. Si lo dejas en null, la app funciona solo en este
// dispositivo (los datos se guardan en el navegador).
window.CAL_CONFIG = {
  // Copia aquí el objeto de Firebase (Consola > Configuración del proyecto > Tus apps)
  // Mismo Firebase que la planificación; tus datos van en una colección aparte.
  firebaseConfig: {
    apiKey: "AIzaSyBLc4g0YhCPMM8x67wA_CttGu-FkqMKg0U",
    authDomain: "padel-gestor.firebaseapp.com",
    projectId: "padel-gestor",
    storageBucket: "padel-gestor.firebasestorage.app",
    messagingSenderId: "619855548313",
    appId: "1:619855548313:web:b0c39533eac1b3ec14cd08"
  },
  // firebaseConfig: {
  //   apiKey: "...",
  //   authDomain: "....firebaseapp.com",
  //   projectId: "...",
  //   storageBucket: "...",
  //   messagingSenderId: "...",
  //   appId: "..."
  // },

  // Cómo entrar en Firestore: "none" (reglas abiertas), "anonymous" o "google"
  auth: "none",

  // Colección NUEVA donde se guardan tus colores y notas (un documento por mes)
  dataCollection: "calendario_personal",

  // Planificación de guardias (herramienta "Control de Turnos"). SOLO LECTURA:
  // de aquí se leen tus guardias, permisos y festivos; nunca se escribe.
  planificacion: {
    firebaseConfig: {
      apiKey: "AIzaSyBLc4g0YhCPMM8x67wA_CttGu-FkqMKg0U",
      authDomain: "padel-gestor.firebaseapp.com",
      projectId: "padel-gestor",
      storageBucket: "padel-gestor.firebasestorage.app",
      messagingSenderId: "619855548313",
      appId: "1:619855548313:web:b0c39533eac1b3ec14cd08"
    },
    collection: "villarramiel",
    document: "turnos_guardias",
    worker: "Juan Manuel"          // se busca en la lista de trabajadores (sin tildes ni mayúsculas)
  }
};
