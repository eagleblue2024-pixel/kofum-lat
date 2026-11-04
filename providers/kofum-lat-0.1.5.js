/* Kofum Lat 0.1.5: experimental Nemo-only native provider. No remote JS execution. */
'use strict';
var MOVIE='https://gnula.life/movies/buscando-a-nemo';
var UA='Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
var HOSTS=['streamwish.com','streamwish.to','niramirus.com','medixiru.com','hanerix.com','hglink.to','hgcloud.to'];
function parsed(s){
  var m=/^https:\/\/([a-z0-9.-]+)(\/[^\s<>"']*)?$/i.exec(String(s||''));
  if(!m)throw new Error('invalid_url');
  var h=m[1].toLowerCase();
  if(h.indexOf('.')<0||/(?:^|\.)(?:localhost|local|internal|test|example|invalid)$/.test(h)||/^\d+(?:\.\d+)*$/.test(h)||h.length>253)throw new Error('invalid_host');
  return{host:h,origin:'https://'+h};
}
function allowed(u){var p=parsed(u);if(HOSTS.indexOf(p.host)<0){var e=new Error('embed_host_unsupported');e.embedHost=p.host;throw e;}return u;}
function clean(s){return String(s||'').replace(/\\\//g,'/').replace(/\\u0026/gi,'&').replace(/&amp;/g,'&');}
function absolute(s,base){s=clean(s);if(/^https:\/\//i.test(s)){parsed(s);return s;}if(/^\/\//.test(s)){parsed('https:'+s);return'https:'+s;}if(/^[a-z]+:/i.test(s)||/[\s<>"']/.test(s)||!s)throw new Error('invalid_url');var u=s.charAt(0)==='/'?parsed(base).origin+s:base.split(/[?#]/)[0].replace(/[^/]*$/,'')+s;parsed(u);return u;}
function moviePlayer(html){
  var re=/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,m,d;
  while((m=re.exec(html)))if(/\bid\s*=\s*["']__NEXT_DATA__["']/i.test(m[1])){d=JSON.parse(m[2]);break;}
  var p=d&&d.props&&d.props.pageProps&&d.props.pageProps.post;
  if(!p||p.IMDbId!=='tt0266543'||String(p.TMDbId)!=='12')throw new Error('movie_mismatch');
  var rows=p.players&&p.players.latino;if(!Array.isArray(rows))throw new Error('missing_players');
  var s=rows.filter(function(x){return x&&x.cyberlocker==='streamwish'&&/^https:\/\/player\.gnula\.life\/player\.php\?h=[A-Za-z0-9_.~-]+$/.test(x.result||'');})[0];
  if(!s)throw new Error('missing_streamwish');return s.result;
}
function unwrap(html){
  var re=/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,m,urls=[];
  while((m=re.exec(html))){var a=/\bvar\s+url\s*=\s*(["'])([^"'\r\n]+)\1\s*;/.exec(m[1]);if(a)urls.push(clean(a[2]));}
  if(!urls.length){re=/<iframe\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi;while((m=re.exec(html)))urls.push(clean(m[2]));}
  urls=urls.filter(function(u,i){return urls.indexOf(u)===i;});if(urls.length!==1)throw new Error(urls.length?'ambiguous_embed':'embed_not_found');return allowed(urls[0]);
}
function mainScript(html,base){
  var re=/<script\b([^>]*)>/gi,m,urls=[];
  while((m=re.exec(html))){var a=/\bsrc\s*=\s*(["'])([^"']+)\1/i.exec(m[1]);if(a&&/(?:^|\/)main\.js(?:[?#]|$)/i.test(clean(a[2]))){var u=absolute(a[2],base);if(parsed(u).host!==parsed(base).host)throw new Error('script_origin_unsupported');if(urls.indexOf(u)<0)urls.push(u);}}
  if(urls.length>1)throw new Error('ambiguous_script');return urls[0]||null;
}
function literalList(js,name){
  var re=new RegExp('\\b'+name+'\\s*=\\s*\\[([\\s\\S]*?)\\]','g'),m=re.exec(js);
  if(!m||m[1].length>20000||re.exec(js))throw new Error('routing_config_not_literal');
  var content=m[1].trim();if(!content)return[];
  if(!/^(?:["'][a-z0-9.-]+["']\s*,\s*)*["'][a-z0-9.-]+["']\s*,?$/i.test(content))throw new Error('routing_config_not_literal');
  var values=content.match(/["'][a-z0-9.-]+["']/gi)||[];
  if(values.length>100)throw new Error('routing_config_not_literal');
  return values.map(function(s){var h=s.slice(1,-1).toLowerCase();parsed('https://'+h+'/');return h;});
}
function routedEmbed(js,embed){
  var main=literalList(js,'main'),dmca=literalList(js,'dmca'),rules=literalList(js,'rules'),p=parsed(embed);
  var choices=rules.indexOf(p.host)>=0?main:dmca;
  if(!choices.length)throw new Error('routing_empty');
  var host=choices.filter(function(h){return h!==p.host&&HOSTS.indexOf(h)>=0;})[0];
  if(!host){var error=new Error('routing_host_unsupported');error.embedHost=choices[0];throw error;}
  return allowed('https://'+host+embed.slice(p.origin.length));
}
function explicitHls(html){
  var re=/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,m,urls=[];
  while((m=re.exec(html))){var fields=/(?:\bfile|\bsrc|["']file["']|["']src["'])\s*:\s*(["'])([^"'\r\n]+)\1/g,a;while((a=fields.exec(m[1]))){var u=clean(a[2]);if(/\.m3u8(?:[?#]|$)/i.test(u)){parsed(u);if(urls.indexOf(u)<0)urls.push(u);}}}
  if(urls.length>1)throw new Error('ambiguous_source');if(!urls.length)throw new Error(/eval\s*\(\s*function\s*\(p,a,c/.test(html)?'packed_script_unsupported':'hls_not_found');return urls[0];
}
function structure(text){return'Estructura: '+text.length+' caracteres · scripts externos '+(text.match(/<script\b[^>]*\bsrc\s*=/gi)||[]).length+' · iframes '+(text.match(/<iframe\b/gi)||[]).length+' · m3u8 '+(text.match(/m3u8/gi)||[]).length;}
function scriptSummary(text){return'Script principal: '+text.length+' caracteres · packed '+(/eval\s*\(\s*function\s*\(p,a,c/.test(text)?'sí':'no')+' · atob '+(/\batob\s*\(/.test(text)?'sí':'no')+' · tablas hex '+(/\b_0x[a-f0-9]+\b/i.test(text)?'sí':'no')+' · configuración literal pendiente de analizar';}
function deadline(callback,ms){
  if(typeof __plugin_sleep==='function'){var cancelled=false,end=Date.now()+ms;function tick(){if(cancelled)return;var left=end-Date.now();if(left<=0){cancelled=true;callback();return;}Promise.resolve(__plugin_sleep(Math.min(left,100))).then(tick,function(){if(!cancelled){cancelled=true;callback();}});}tick();return function(){cancelled=true;};}
  if(typeof setTimeout!=='function')throw new Error('timer_unavailable');var id=setTimeout(callback,ms);return function(){if(typeof clearTimeout==='function')clearTimeout(id);};
}
function read(url,referer,job,stage){
  parsed(url);if(Date.now()>=job.end||++job.calls>10)return Promise.reject(new Error('lookup_limit'));
  return new Promise(function(resolve,reject){var done=false,stop,controller=typeof AbortController==='function'?new AbortController():null,start=Date.now();function finish(e,v){if(done)return;done=true;if(stop)stop();if(e)reject(e);else resolve(v);}
    try{stop=deadline(function(){if(controller){try{controller.abort();}catch(_){}}finish(new Error('request_timeout'));},Math.min(6500,job.end-start));var options={headers:{Referer:referer,'User-Agent':UA}};if(controller)options.signal=controller.signal;
      Promise.resolve().then(function(){return fetch(url,options);}).then(function(r){if(done)return;if(r.ok===false||r.status>=400)throw new Error('http_'+r.status);if(r.url&&parsed(r.url).host!==parsed(url).host)throw new Error('cross_host_redirect_unsupported');return Promise.resolve(r.text()).then(function(body){if(done)return;if(typeof body!=='string'||body.length>3000000)throw new Error('response_too_large');job.events.push(stage+': HTTP '+(r.status||200)+' · '+(Date.now()-start)+' ms');finish(null,body);});}).catch(function(e){finish(e);});
    }catch(e){finish(e);}
  });
}
function resolveEmbed(url,referer,job,depth){
  if(depth>2||job.seen[url])return Promise.reject(new Error('routing_loop'));job.seen[url]=true;allowed(url);
  return read(url,referer,job,'Servidor').then(function(body){
    if(job.diagnostic)job.events.push(structure(body));
    var script=mainScript(body,url);
    if(!script)return{hls:explicitHls(body),embed:url};
    job.events.push('main.js real identificado; se consulta sin ejecutarlo.');
    return read(script,url,job,'Script principal').then(function(js){if(job.diagnostic)job.events.push(scriptSummary(js));var next=routedEmbed(js,url);job.events.push('Ruta literal hacia servidor permitido; ID y parámetros conservados.');return resolveEmbed(next,url,job,depth+1);});
  });
}
function verifyHls(url,referer,job,depth){
  if(depth>2)return Promise.reject(new Error('playlist_depth'));
  return read(url,referer,job,'HLS').then(function(body){if(!/^\s*#EXTM3U\b/.test(body))throw new Error('not_hls');var lines=body.split(/\r?\n/),best=null;
    for(var i=0;i<lines.length;i++)if(/^#EXT-X-STREAM-INF:/.test(lines[i])){var r=/RESOLUTION=\d+x(\d+)/.exec(lines[i]),h=r?+r[1]:0;for(var j=i+1;j<lines.length;j++)if(lines[j].trim()&&lines[j].charAt(0)!=='#'){if(!best||h>best.height)best={height:h,url:absolute(lines[j].trim(),url)};break;}}
    if(best)return verifyHls(best.url,referer,job,depth+1);if(!/#EXTINF:/.test(body))throw new Error('empty_playlist');return true;
  });
}
function probe(job){
  var resolved,headers;
  return read(MOVIE,'https://gnula.life/',job,'Ficha').then(function(body){return read(moviePlayer(body),MOVIE,job,'Intermedio');}).then(function(body){var embed=unwrap(body);job.events.push('Destino del reproductor identificado.');return resolveEmbed(embed,MOVIE,job,0);}).then(function(result){resolved=result;headers={Referer:parsed(result.embed).origin+'/', 'User-Agent':UA};job.events.push('Configuración HLS explícita encontrada.');return verifyHls(result.hls,headers.Referer,job,0);}).then(function(){job.events.push('Playlist HLS accesible; segmentos y reproducción no comprobados.');return[{name:'Kofum Lat',title:'Latino · Auto · Streamwish\nExperimental: Nemo',url:resolved.hls,type:'m3u8',quality:'Auto',provider:'kofum-lat',language:'es',headers:headers,subtitles:[],behaviorHints:{notWebReady:true,proxyHeaders:{request:headers}}}];});
}
function newJob(){return{end:Date.now()+26000,calls:0,seen:Object.create(null),events:[]};}
function safeError(e){var s=e&&e.message||'';return /^(?:http_\d+|invalid_url|invalid_host|movie_mismatch|missing_players|missing_streamwish|ambiguous_embed|embed_not_found|embed_host_unsupported|script_origin_unsupported|ambiguous_script|routing_config_not_literal|routing_empty|routing_host_unsupported|routing_loop|ambiguous_source|packed_script_unsupported|hls_not_found|timer_unavailable|request_timeout|lookup_limit|response_too_large|cross_host_redirect_unsupported|not_hls|empty_playlist|playlist_depth)$/.test(s)?s:'network_or_parse_error';}
function getStreams(id,type){if(!/^(?:movie|movies|film)$/i.test(String(type||''))||!/^(?:12|tmdb:12|tt0266543|imdb:tt0266543)$/.test(String(id||'')))return Promise.resolve([]);return Promise.resolve().then(function(){return probe(newJob());}).catch(function(){return[];});}
function onSettings(){var job=newJob(),layout=[{type:'header',label:'Kofum Lat 0.1.5 · Prueba Nemo'},{type:'info',label:'Experimental: solo Nemo latino. Consulta el main.js real del mismo origen y admite rutas literales main/dmca/rules. No ejecuta scripts remotos ni admite ofuscación general.'}];job.diagnostic=true;
  return Promise.resolve().then(function(){return probe(job);}).then(function(streams){job.events.push('Fuentes candidatas: '+streams.length+'; reproducción real pendiente.');},function(e){job.events.push('ERROR '+safeError(e));if(e&&/^(?:embed_host_unsupported|routing_host_unsupported)$/.test(e.message||'')&&/^[a-z0-9.-]{1,253}$/.test(e.embedHost||''))job.events.push('Dominio no admitido: '+e.embedHost);}).then(function(){job.events.forEach(function(s){layout.push({type:'info',label:s});});layout.push({type:'info',label:'Solo conteos, indicadores y dominio no admitido. Sin URLs completas, rutas, parámetros, cookies ni cuerpos de respuesta. Sin telemetría adicional.'});return layout;});
}
module.exports={getStreams:getStreams,onSettings:onSettings,mainScript:mainScript,literalList:literalList,routedEmbed:routedEmbed,unwrap:unwrap,explicitHls:explicitHls,scriptSummary:scriptSummary};
