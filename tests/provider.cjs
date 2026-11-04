const assert = require('node:assert/strict');
const {extractPlayers,getStreams,onSettings} = require('../providers/kofum-lat.js');
const url = 'https://player.gnula.life/player.php?h=rxPRsRSX4IlkyS1F21W5j7yEF5hgjp3WNStwp3OXnZ.xhDGbxZHrdMxAz.9D9fiL';
const post = {IMDbId:'tt0266543',players:{latino:[{cyberlocker:'streamwish',result:url,quality:'HD'}],spanish:[],english:[]},downloads:[{result:'https://example.com/download'}]};
const html = p => '<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{post:p}}})+'</script>';
const cases = [
 ['extrae enlace exacto', () => assert.equal(extractPlayers(html(post))[0].url,url)],
 ['verifica IMDb', () => assert.equal(extractPlayers(html(post),'tt0266543').length,1)],
 ['rechaza otra película', () => assert.throws(() => extractPlayers(html(post),'tt0000000'),/movie_mismatch/)],
 ['sin bloque', () => assert.throws(() => extractPlayers(''),/missing_next_data/)],
 ['JSON inválido', () => assert.throws(() => extractPlayers('<script id="__NEXT_DATA__">{</script>'),/invalid_json/)],
 ['sin players', () => assert.throws(() => extractPlayers(html({})),/missing_players/)],
 ['deduplica', () => assert.equal(extractPlayers(html({...post,players:{latino:[post.players.latino[0],post.players.latino[0]]}})).length,1)],
 ['rechaza host ajeno', () => assert.equal(extractPlayers(html({...post,players:{latino:[{result:'https://evil.example/video'}]}})).length,0)],
 ['no inventa resolución', () => assert.equal(extractPlayers(html(post))[0].verifiedResolution,null)],
 ['no ofrece reproducción ficticia', async () => assert.deepEqual(await getStreams('12','movie'),[])],
 ['diagnóstico con HTTP simulado', async () => {
   let requests = 0;
   global.fetch = async () => ({ok:true,status:200,text:async () => ++requests === 1 ? html(post) : '<iframe></iframe>'});
   const result = await onSettings();
   assert.equal(requests,2);
   assert.ok(result.some(x => x.label.includes('Reproductor: HTTP 200')));
   assert.ok(result.every(x => !x.label.includes('https://')));
 }],
 ['diagnóstico no expone error sensible', async () => {
   global.fetch = async () => {throw new Error('https://secret.example/?token=private');};
   const result = await onSettings();
   assert.ok(result.some(x=>x.label.includes('network_or_parse_error')));
   assert.ok(result.every(x=>!x.label.includes('secret.example')));
 }]
];
(async () => {
  const results = [];
  for (const [name,run] of cases) {
    try { await run(); results.push({name,passed:true}); }
    catch(e) {results.push({name,passed:false,error:e.message});}
  }
  const report = {passed:results.filter(x=>x.passed).length,total:results.length,scope:'Local fixture and mocked HTTP only; no device, live HTTP or playback verification.',results};
  process.stdout.write(JSON.stringify(report,null,2));
  if (report.passed !== report.total) process.exitCode=1;
})().catch(()=>{process.exitCode=1;});
