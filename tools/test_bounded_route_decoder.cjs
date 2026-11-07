"use strict";
const assert=require('node:assert/strict'),acorn=require('internal/deps/acorn/acorn/dist/acorn'),model=require('./bounded_route_decoder.cjs');
let passed=0;const check=(actual,expected)=>{assert.deepEqual(actual,expected);passed++;};
function evaluate(source,expression,limit){const ast=acorn.parse(source,{ecmaVersion:'latest'}),m=model.machine(source,limit);m.hoist(ast.body,m.global,true);return m.expr(acorn.parse('('+expression+')',{ecmaVersion:'latest'}).body[0].expression,m.global);}
const cases=[
 ['', '1+2*3',7],['','"ab"+"cd"','abcd'],['','false&&unknown()',false],['','true||unknown()',true],['','null??"fallback"','fallback'],['','1<2?"yes":"no"','yes'],
 ['function f(){var s=0;for(var i=0;i<5;i++)s+=i;return s;}','f()',10],
 ['function f(){var i=0;while(i<3)i++;return i;}','f()',3],
 ['function f(){var i=0;do{i++;}while(i<2);return i;}','f()',2],
 ['function f(){var s=0;for(var i=0;i<10;i++){if(i===2)continue;if(i===5)break;s+=i;}return s;}','f()',8],
 ['function f(){return x;var x=1;}','f()',undefined],
 ['function table(){var a=[1,2];table=function(){return a;};return table();}function f(){table().push(3);return table().length;}','f()',3],
 ['function f(){f.cache=f.cache||{};f.cache.a=7;return f.cache.a;}','f()',7],
 ['function f(){try{throw "hidden";}catch(e){return "caught";}}','f()','caught'],
 ['function f(){try{return 1;}finally{return 2;}}','f()',2],
 ['function f(){try{throw new Error("secret");}catch(e){return e.message;}}','f()','secret'],
 ['','String.fromCharCode(65,66)','AB'],['','decodeURIComponent("%C3%B1")','ñ'],['','parseInt("31415rest")',31415],
 ['','[1,2,3].slice(1).join("-")','2-3'],['','"test".charCodeAt(0)',116],['','"abcd".substring(1,3)','bc'],
 ['function f(x){return x+1;}','f.call(null,4)',5],['function f(x){return x+1;}','f.apply(null,[5])',6],
 ['function f(){var a=[2,3];a.unshift(1);a.shift();return a.join(",");}','f()','2,3'],
 ['function f(){var x={a:3};delete x.a;return x.a;}','f()',undefined]
];
for(const [source,expression,expected] of cases)check(evaluate(source,expression),expected);
for(const [source,expression,code,limit] of [
 ['', 'process','ast_name_forbidden'],['','fetch("https://private.example")','ast_name_forbidden'],['','eval("1")','ast_name_forbidden'],['','Function("return 1")','ast_name_forbidden'],['','require("node:fs")','ast_name_forbidden'],['','({}).constructor','ast_property_forbidden'],['','({})["__proto__"]','ast_property_forbidden'],['','[1].prototype','ast_property_forbidden'],['','({get a(){return 1;}}).a','ast_object_unsupported'],
 ['function f(){while(true){}}','f()','ast_budget_exceeded',500],
 ['function f(){try{process;}catch(e){return 1;}finally{return 2;}}','f()','ast_name_forbidden'],
 ['function f(){try{throw 1;}catch(e){process;}finally{return 2;}}','f()','ast_name_forbidden'],
 ['','Array(9000)','ast_data_limit'],['','[,1]','ast_sparse_array_unsupported'],['','"a".search("a")','ast_regex_unsupported'],['','(()=>1)()','ast_arrow_unsupported']
]){let actual='';try{evaluate(source,expression,limit);}catch(e){actual=e.code;}check(actual,code);}
const fixture=`function table(){var a=["rHG+pU7gqWpn4SHG7Khlj+PtGdva", "unm/r0SqrnFmuzLd8fJ+mPI=", "7CXp+xU=", "r2a0p0H2sTZ4pj/b4a510+imAw=="];table=function(){return a;};return table();}
function from64(text){var abc='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',bits=0,buffer=0,out='';for(var i=0;i<text.length;i++){var v=abc.indexOf(text.charAt(i));if(v>=0){buffer=(buffer<<6)|v;bits+=6;if(bits>=8){bits-=8;out+=String.fromCharCode((buffer>>bits)&255);}}}return out;}
function crypt(text,key){var s=[],j=0,x,out='';for(var i=0;i<256;i++)s[i]=i;for(i=0;i<256;i++){j=(j+s[i]+key.charCodeAt(i%key.length))%256;x=s[i];s[i]=s[j];s[j]=x;}i=0;j=0;for(var y=0;y<text.length;y++){i=(i+1)%256;j=(j+s[i])%256;x=s[i];s[i]=s[j];s[j]=x;out+=String.fromCharCode(text.charCodeAt(y)^s[(s[i]+s[j])%256]);}return out;}
function _0x5447(index,key){var data=table();return _0x5447=function(i,k){return crypt(from64(data[i]),k);},_0x5447(index,key);}
function bridge(a,b,c,d,e){return _0x5447(b-4,d);}
(function(t,n){var a=t();while(true){if(parseInt(_0x5447(0,'fixture-key'))===n)break;a.push(a.shift());}})(table,31415);
const main=[bridge(0,5,0,'fixture-key',0)+''],dmca=[_0x5447(2,'fixture-key')],rules=[_0x5447(3,'fixture-key')];
`;
const report=model.recover(fixture,{pin:null});
check(report.lists,{main:['primary.fixture.net'],dmca:['secondary.fixture.net'],rules:['embed.fixture.net']});
check(report.status,'ast_route_candidates_recovered');
let changed='';try{model.recover(fixture);}catch(e){changed=e.code;}check(changed,'ast_source_hash_changed');
delete globalThis.__bounded_fixture_marker;model.recover('globalThis.__bounded_fixture_marker=true;'+fixture,{pin:null});check(globalThis.__bounded_fixture_marker,undefined);
const noDomains=fixture.replace("_0x5447(3,'fixture-key')","'https://secret.example/?token=private'");let rejected='';try{model.recover(noDomains,{pin:null});}catch(e){rejected=e.code;}check(rejected,'ast_route_domains_rejected');
process.stdout.write(JSON.stringify({passed,total:cases.length+16+5,scope:'Synthetic encrypted table, rotation, RC4, forwarding, concatenation, limits and forbidden-capability tests. No real source tested.'}));
