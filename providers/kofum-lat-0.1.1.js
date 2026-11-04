/* Kofum Lat 0.1.1 - experimental Nemo-only playback probe. */
'use strict';
var MOVIE='https://gnula.life/movies/buscando-a-nemo';
var UA='Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
var HOSTS=['streamwish.com','niramirus.com','medixiru.com','hanerix.com','hglink.to','hgcloud.to'];
function parseUrl(s) {
  var m=/^https:\/\/([a-z0-9.-]+)(\/[^\s<>"']*)?$/i.exec(String(s||''));
  if(!m) throw new Error('invalid_url');
  var h=m[1].toLowerCase();
  if(h.indexOf('.')<0 || /(?:^|\.)(?:localhost|local|internal|test|example|invalid)$/.test(h) || /^\d+(?:\.\d+)*$/.test(h) || h.length>253) throw new Error('invalid_host');
  return {host:h,url:s,origin:'https://'+h};
}
function clean(s) {
  return String(s||'').replace(/\\\//g,'/').replace(/\\u0026/gi,'&').replace(/&amp;/g,'&');
}
function extract(html) {
  var re=/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,m,data;
  while((m=re.exec(html))) if(/\bid\s*=\s*["']__NEXT_DATA__["']/i.test(m[1])) {data=JSON.parse(m[2]);break;}
  var p=data && data.props && data.props.pageProps && data.props.pageProps.post;
  if(!p || p.IMDbId!=='tt0266543' || String(p.TMDbId)!=='12') throw new Error('movie_mismatch');
  var rows=p.players && p.players.latino;
  if(!Array.isArray(rows)) throw new Error('missing_players');
  var selected=rows.filter(function(x){return x && x.cyberlocker==='streamwish' && /^https:\/\/player\.gnula\.life\/player\.php\?h=[A-Za-z0-9_.~-]+$/.test(x.result||'');})[0];
  if(!selected) throw new Error('missing_streamwish');
  return selected.result;
}
function unwrap(html) {
  var re=/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,m,urls=[];
  while((m=re.exec(html))) {
    var a=/\bvar\s+url\s*=\s*(["'])([^"'\r\n]+)\1\s*;/.exec(m[1]);
    if(a) urls.push(clean(a[2]));
  }
  if(!urls.length) {
    re=/<iframe\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi;
    while((m=re.exec(html))) urls.push(clean(m[2]));
  }
  urls=urls.filter(function(u,i){return urls.indexOf(u)===i;});
  if(urls.length!==1) throw new Error(urls.length?'ambiguous_embed':'embed_not_found');
  var parsed=parseUrl(urls[0]);
  if(HOSTS.indexOf(parsed.host)<0) throw new Error('embed_host_unsupported');
  return urls[0];
}
function source(html) {
  var scripts=/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,m,urls=[];
  while((m=scripts.exec(html))) {
    var re=/(?:\bfile|\bsrc|["']file["']|["']src["'])\s*:\s*(["'])([^"'\r\n]+)\1/g,a;
    while((a=re.exec(m[1]))) {
      var u=clean(a[2]);
      if(/\.m3u8(?:[?#]|$)/i.test(u)) {parseUrl(u);if(urls.indexOf(u)<0) urls.push(u);}
    }
  }
  if(urls.length>1) throw new Error('ambiguous_source');
  if(!urls.length) throw new Error(/eval\s*\(\s*function\s*\(p,a,c/.test(html)?'packed_script_unsupported':'hls_not_found');
  return urls[0];
}
function deadline(callback,ms) {
  if(typeof __plugin_sleep==='function') {
    var cancelled=false,end=Date.now()+ms;
    function tick(){if(cancelled)return;var left=end-Date.now();if(left<=0){cancelled=true;callback();return;}Promise.resolve(__plugin_sleep(Math.min(left,100))).then(tick,function(){if(!cancelled){cancelled=true;callback();}});}
    tick();return function(){cancelled=true;};
  }
  if(typeof setTimeout!=='function') throw new Error('timer_unavailable');
  var id=setTimeout(callback,ms);return function(){if(typeof clearTimeout==='function')clearTimeout(id);};
}
function request(url,referer,job,stage) {
  parseUrl(url);
  if(Date.now()>=job.end) return Promise.reject(new Error('lookup_timeout'));
  return new Promise(function(resolve,reject){
    var done=false,stop,controller=typeof AbortController==='function'?new AbortController():null;
    function finish(e,v){if(done)return;done=true;if(stop)stop();if(e)reject(e);else resolve(v);}
    var start=Date.now();
    try {
      stop=deadline(function(){if(controller){try{controller.abort();}catch(_){}}finish(new Error('request_timeout'));},Math.min(6500,job.end-start));
      var options={headers:{Referer:referer,'User-Agent':UA}};if(controller)options.signal=controller.signal;
      Promise.resolve().then(function(){return fetch(url,options);}).then(function(r){
        if(done)return;
        if(r.ok===false || r.status>=400)throw new Error('http_'+r.status);
        if(r.url) {var requested=parseUrl(url),actual=parseUrl(r.url);if(requested.host!==actual.host)throw new Error('cross_host_redirect_unsupported');}
        return Promise.resolve(r.text()).then(function(body){
          if(done)return;
          if(typeof body!=='string'||body.length>3000000)throw new Error('response_too_large');
          job.events.push(stage+': HTTP '+(r.status||200)+' · '+(Date.now()-start)+' ms');
          finish(null,body);
        });
      }).catch(function(e){finish(e);});
    }catch(e){finish(e);}
  });
}
function safeError(e) {
  var s=e&&e.message||'';
  return /^(?:http_\d+|invalid_url|invalid_host|movie_mismatch|missing_players|missing_streamwish|ambiguous_embed|embed_not_found|embed_host_unsupported|ambiguous_source|packed_script_unsupported|hls_not_found|timer_unavailable|request_timeout|lookup_timeout|response_too_large|cross_host_redirect_unsupported|not_hls|empty_playlist|playlist_depth)$/.test(s)?s:'network_or_parse_error';
}
function playlistUrl(line,base){
  if(/^https:\/\//i.test(line)){parseUrl(line);return line;}
  if(/^\/\//.test(line)){parseUrl('https:'+line);return 'https:'+line;}
  if(/^[a-z]+:/i.test(line)||/[\s<>"']/.test(line))throw new Error('invalid_url');
  var u=line.charAt(0)==='/'?parseUrl(base).origin+line:base.split(/[?#]/)[0].replace(/[^/]*$/,'')+line;
  parseUrl(u);return u;
}
function verifyHls(url,referer,job,depth) {
  if(depth>2)return Promise.reject(new Error('playlist_depth'));
  return request(url,referer,job,'HLS').then(function(body){
    if(!/^\s*#EXTM3U\b/.test(body))throw new Error('not_hls');
    var lines=body.split(/\r?\n/), best=null;
    for(var i=0;i<lines.length;i++) if(/^#EXT-X-STREAM-INF:/.test(lines[i])) {
      var resolution=/RESOLUTION=\d+x(\d+)/.exec(lines[i]),height=resolution?+resolution[1]:0;
      for(var j=i+1;j<lines.length;j++)if(lines[j].trim()&&lines[j].charAt(0)!=='#'){
        if(!best||height>best.height)best={height:height,url:playlistUrl(lines[j].trim(),url)};break;
      }
    }
    if(best)return verifyHls(best.url,referer,job,depth+1);
    if(!/#EXTINF:/.test(body))throw new Error('empty_playlist');
    return true;
  });
}
function probe(job) {
  var embed, hls, headers;
  return request(MOVIE,'https://gnula.life/',job,'Ficha').then(function(body){
    return request(extract(body),MOVIE,job,'Intermedio');
  }).then(function(body){
    embed=unwrap(body);job.events.push('Destino del reproductor identificado.');
    return request(embed,MOVIE,job,'Servidor');
  }).then(function(body){
    hls=source(body);job.events.push('Configuración HLS explícita encontrada.');
    headers={Referer:parseUrl(embed).origin+'/', 'User-Agent':UA};
    return verifyHls(hls,headers.Referer,job,0);
  }).then(function(){
    job.events.push('Playlist HLS accesible; segmentos y reproducción todavía no comprobados.');
    return [{name:'Kofum Lat',title:'Latino · Auto · Streamwish\nExperimental: Nemo',url:hls,type:'m3u8',quality:'Auto',provider:'kofum-lat',language:'es',headers:headers,subtitles:[],behaviorHints:{notWebReady:true,proxyHeaders:{request:headers}}}];
  });
}
function newJob(){return {end:Date.now()+26000,events:[]};}
function getStreams(id,type) {
  if(!/^(?:movie|movies|film)$/i.test(String(type||'')) || !/^(?:12|tmdb:12|tt0266543|imdb:tt0266543)$/.test(String(id||''))) return Promise.resolve([]);
  return Promise.resolve().then(function(){return probe(newJob());}).catch(function(){return [];});
}
function onSettings(){
  var job=newJob(),layout=[{type:'header',label:'Kofum Lat 0.1.1 · Prueba Nemo'},{type:'info',label:'Solo Nemo latino. Admite configuración HLS explícita; formatos ofuscados todavía no soportados. Sin búsqueda general.'}];
  return Promise.resolve().then(function(){return probe(job);}).then(function(streams){job.events.push('Fuentes candidatas: '+streams.length+'; prueba real en el reproductor pendiente.');},function(e){job.events.push('ERROR '+safeError(e));}).then(function(){
    job.events.forEach(function(event){layout.push({type:'info',label:event});});
    layout.push({type:'info',label:'Sin URLs ni cuerpos de respuesta en el panel. Sin telemetría adicional. Las consultas se hacen desde tu conexión.'});return layout;
  });
}
module.exports={getStreams:getStreams,onSettings:onSettings,extract:extract,unwrap:unwrap,source:source,parseUrl:parseUrl};
