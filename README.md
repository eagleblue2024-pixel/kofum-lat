# Kofum Lat 0.1.5 experimental

Plugin nativo de Nuvio, solo GitHub. Sin Vercel, backend ni catálogo.
Limitado a Buscando a Nemo latino (TMDb 12 / IMDb tt0266543), Streamwish. Sin búsqueda general.

Consulta el main.js exacto indicado por la página, solo del mismo origen. No ejecuta JavaScript remoto: únicamente admite listas literales main/dmca/rules y selecciona un dominio ya permitido. Conserva ruta, identificador y parámetros originales. No prueba el ID en dominios arbitrarios ni admite automáticamente hosts nuevos.
Si el script está ofuscado o usa otro formato, devuelve routing_config_not_literal. No admite ofuscación general, CAPTCHA ni redirecciones HTTP entre dominios.

19 pruebas locales con fixtures y HTTP simulado pasaron; disponibles en el ZIP experimental de la conversación. El main.js real y su routing siguen sin examinarse en vivo. No hay reproducción confirmada. Una playlist accesible no prueba segmentos ni decodificación.
El cliente HTTP puede seguir redirecciones antes de inspeccionar la URL final. El filtrado de URL no verifica DNS: no es protección SSRF de backend.
El diagnóstico muestra conteos, indicadores y dominio no admitido, sin URLs completas ni cuerpos. Sin telemetría adicional; consultas desde la conexión del dispositivo.

Manifiesto después de publicar:
https://raw.githubusercontent.com/eagleblue2024-pixel/kofum-lat/main/manifest.json
Abre ajustes y comparte el diagnóstico completo. Las pruebas antiguas del repositorio son históricas, no cubren esta versión.
