# Kofum Lat 0.1.1 experimental

Plugin nativo de Nuvio: solo GitHub, sin Vercel, backend ni catálogo.

Prueba limitada a Nemo latino (TMDb 12 / IMDb tt0266543). Sin búsqueda general.
Extrae el destino literal var url o un iframe único. Admite servidores enumerados y una fuente HLS explícita. Comprueba playlists, no segmentos ni decodificación. Conserva el master para calidad Auto, sin afirmar resolución máxima.
Scripts packed, destinos desconocidos y redirecciones entre dominios no están soportados. No ejecuta JavaScript remoto ni elude CAPTCHA.

17 pruebas locales con fixtures y HTTP simulado pasaron; están incluidas en el ZIP experimental adjunto en la conversación. No hay resolución final en vivo ni reproducción confirmada en 0.1.1. Las pruebas antiguas del repositorio son de 0.1.0.
La captura del usuario solo valida ficha y reproductor intermedio en 0.1.0.

Manifiesto tras publicar:
https://raw.githubusercontent.com/eagleblue2024-pixel/kofum-lat/main/manifest.json
Abre ajustes para el diagnóstico. Solo si obtiene una fuente candidata, prueba Nemo en el reproductor. HTTP 200 o HLS válido no prueban reproducción.

Sin telemetría adicional ni URLs/cookies/cuerpos en el panel. Consultas desde tu conexión. El filtro URL no valida DNS ni evita que el cliente siga redirecciones antes de comprobar su URL final; no es protección SSRF para un backend.
