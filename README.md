# Kofum Lat

Plugin nativo experimental para Nuvio. Solo GitHub; sin Vercel, servidor ni catálogo.

## Estado 0.1.0
- Extrae opciones de post.players desde __NEXT_DATA__.
- Valida el IMDb solicitado, filtra URLs y elimina duplicados.
- Incluye onSettings para probar la ficha de Buscando a Nemo y su reproductor Streamwish latino desde el dispositivo.
- getStreams devuelve [] intencionadamente: el resolvedor de vídeo todavía no está implementado. No es una versión lista para reproducir.

## Instalación experimental
Una vez publicados estos archivos, el manifiesto será:
https://raw.githubusercontent.com/eagleblue2024-pixel/kofum-lat/main/manifest.json
Requiere una edición de Nuvio que admita proveedores JavaScript y onSettings. No se ha comprobado la instalación en un dispositivo.

## Diagnóstico
Abre los ajustes del proveedor. El panel muestra estados HTTP, tiempos, conteos y errores sanitizados. Consulta únicamente la ficha de prueba y un reproductor; no resuelve ni valida un vídeo. No ejecuta scripts remotos ni resuelve CAPTCHA. El cliente HTTP puede seguir redirecciones; el filtrado inicial no es una garantía SSRF para un backend.
Sin telemetría adicional; las solicitudes revelan tu conexión al origen. No se muestran URLs firmadas, cookies o cuerpos de respuesta en el panel.
HD es una etiqueta de la web, no una resolución medida. english es el grupo que la muestra presenta como Subtitulado; no confirma audio ni subtítulos reales.

## Pruebas
node tests/provider.cjs
Casos sintéticos derivados de la estructura aportada por el usuario y HTTP simulado, no pruebas en vivo. La compatibilidad del formato se basa en el proveedor de referencia revisado; no sustituye una prueba real en Nuvio.

## Pendiente
Búsqueda y coincidencia de títulos para otras películas, resolución de reproductores, verificación de fuentes finales y cabeceras, calidad real y reproducción en Nuvio.
