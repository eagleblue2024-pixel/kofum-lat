/* Kofum Lat 0.1.0: diagnostic build, not playback-ready. */
'use strict';
var BASE = 'https://gnula.life';
var MOVIE = BASE + '/movies/buscando-a-nemo';
var UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
function extractPlayers(html, imdb) {
  if (typeof html !== 'string' || html.length > 3000000) throw new Error('invalid_html');
  var re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, m, data;
  while ((m = re.exec(html))) {
    if (/(?:^|\s)id\s*=\s*(?:"__NEXT_DATA__"|'__NEXT_DATA__')/i.test(m[1])) {
      try { data = JSON.parse(m[2]); } catch (_) { throw new Error('invalid_json'); }
      break;
    }
  }
  if (!data) throw new Error('missing_next_data');
  var p = data.props && data.props.pageProps && data.props.pageProps.post;
  if (!p || !p.players) throw new Error('missing_players');
  if (imdb && p.IMDbId !== imdb) throw new Error('movie_mismatch');
  var rows = [], seen = Object.create(null);
  ['latino','spanish','english'].forEach(function (group) {
    var list = p.players[group];
    if (!Array.isArray(list)) return;
    list.forEach(function (item) {
      if (!item || typeof item.result !== 'string') return;
      var url = item.result.trim();
      if (!/^https:\/\/player\.gnula\.life\/player\.php\?h=[A-Za-z0-9_.~-]+$/.test(url)) return;
      var key = group + '|' + url;
      if (seen[key]) return;
      seen[key] = true;
      rows.push({group:group, server:String(item.cyberlocker || '').toLowerCase(), url:url,
        declaredQuality:typeof item.quality === 'string' ? item.quality : '', verifiedResolution:null});
    });
  });
  return rows;
}
function timer(callback, ms) {
  if (typeof __plugin_sleep === 'function') {
    var cancelled = false, end = Date.now() + ms;
    function tick() {
      if (cancelled) return;
      var left = end - Date.now();
      if (left <= 0) { cancelled = true; callback(); return; }
      Promise.resolve(__plugin_sleep(Math.min(100,left))).then(tick, function () {
        if (!cancelled) { cancelled = true; callback(); }
      });
    }
    tick();
    return function () { cancelled = true; };
  }
  if (typeof setTimeout !== 'function') throw new Error('timer_unavailable');
  var id = setTimeout(callback,ms);
  return function () { if (typeof clearTimeout === 'function') clearTimeout(id); };
}
function request(url, referer) {
  if (url !== MOVIE && !/^https:\/\/player\.gnula\.life\/player\.php\?h=[A-Za-z0-9_.~-]+$/.test(url)) return Promise.reject(new Error('invalid_url'));
  return new Promise(function (resolve,reject) {
    var done = false, stop, controller = typeof AbortController === 'function' ? new AbortController() : null;
    function finish(error,value) {
      if (done) return;
      done = true;
      if (stop) stop();
      if (error) reject(error); else resolve(value);
    }
    try {
      stop = timer(function () {
        if (controller) { try { controller.abort(); } catch (_) {} }
        finish(new Error('request_timeout'));
      },8000);
      var options = {headers:{Referer:referer || BASE + '/', 'User-Agent':UA}};
      if (controller) options.signal = controller.signal;
      Promise.resolve().then(function () { return fetch(url,options); }).then(function (response) {
        if (done) return;
        if (response.status >= 400 || response.ok === false) throw new Error('http_' + response.status);
        return Promise.resolve(response.text()).then(function (body) {
          if (typeof body !== 'string' || body.length > 3000000) throw new Error('response_too_large');
          finish(null,{body:body,status:response.status || 200});
        });
      }).catch(function (error) { finish(error); });
    } catch (error) { finish(error); }
  });
}
function safeError(error) {
  var code = error && error.message || '';
  return /^(?:http_\d+|request_timeout|timer_unavailable|invalid_url|response_too_large|invalid_html|invalid_json|missing_next_data|missing_players|movie_mismatch)$/.test(code) ? code : 'network_or_parse_error';
}
function getStreams() {
  // Resolver not implemented: never pass intermediate HTML pages to the player.
  return Promise.resolve([]);
}
function onSettings() {
  var layout = [
    {type:'header',label:'Kofum Lat 0.1.0 · Diagnóstico'},
    {type:'info',label:'Versión experimental: todavía no reproduce. Prueba de conexión con Buscando a Nemo.'}
  ];
  var started = Date.now(), stage = 'Ficha';
  return request(MOVIE).then(function (r) {
    layout.push({type:'info',label:'Ficha: HTTP ' + r.status + ' · ' + (Date.now()-started) + ' ms'});
    var rows = extractPlayers(r.body,'tt0266543');
    ['latino','spanish','english'].forEach(function (group) {
      layout.push({type:'info',label:group + ': ' + rows.filter(function (x) { return x.group === group; }).length + ' opciones'});
    });
    var selected = rows.filter(function (x) { return x.group === 'latino' && x.server === 'streamwish'; })[0];
    if (!selected) {
      layout.push({type:'info',label:'No se encontró Streamwish latino en la ficha.'});
      return null;
    }
    stage = 'Reproductor'; started = Date.now();
    return request(selected.url,MOVIE).then(function (player) {
      layout.push({type:'info',label:'Reproductor: HTTP ' + player.status + ' · ' + (Date.now()-started) + ' ms'});
      var protection = /cf-chl-|checking your browser|just a moment|captcha/i.test(player.body);
      layout.push({type:'info',label:protection ? 'Posible página de protección; HTTP exitoso no confirma acceso al vídeo.' : 'Respuesta recibida. Fuente de vídeo todavía no resuelta ni verificada.'});
    });
  }).catch(function (error) {
    layout.push({type:'info',label:stage + ': ERROR ' + safeError(error)});
  }).then(function () {
    layout.push({type:'info',label:'Sin telemetría. No se muestran URLs, cookies ni cuerpos de respuesta. Abrir este panel consulta el origen desde tu dispositivo.'});
    return layout;
  });
}
module.exports = {getStreams:getStreams,onSettings:onSettings,extractPlayers:extractPlayers};
