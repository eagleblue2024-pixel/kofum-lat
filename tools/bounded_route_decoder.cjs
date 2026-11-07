"use strict";
const fs=require('node:fs'),crypto=require('node:crypto'),acorn=require('internal/deps/acorn/acorn/dist/acorn');
const PIN='15b9ce8846e132e81a1f3bcad60f26e26ed8752dd2dc93f78b1b64284a1ef796';
class Fatal extends Error{constructor(code){super(code);this.code=code;}}
class Flow{constructor(kind,value){this.kind=kind;this.value=value;}}
class Obj{constructor(){this.p=new Map();}}
class Fn extends Obj{constructor(node,scope){super();this.node=node;this.scope=scope;}}
class Native{constructor(name,receiver){this.name=name;this.receiver=receiver;}}
class Lazy{constructor(node,scope){this.node=node;this.scope=scope;this.busy=false;}}
class Scope{constructor(parent=null,isFunction=false){this.parent=parent;this.isFunction=isFunction;this.p=new Map();this.thisValue=parent?parent.thisValue:undefined;}owner(name){if(this.p.has(name))return this;return this.parent?this.parent.owner(name):null;}varScope(){return this.isFunction||!this.parent?this:this.parent.varScope();}}
function fatal(code){throw new Fatal(code);}
function walk(root,visit){const stack=[root];let count=0;while(stack.length){const n=stack.pop();if(++count>100000)fatal('ast_node_limit');visit(n);for(const v of Object.values(n)){if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')stack.push(c);}else if(v&&typeof v.type==='string')stack.push(v);}}}
function machine(source,limit=100000000){
 let steps=0,depth=0,allocations=0;const start=Date.now(),props=new WeakMap(),globalObject=new Obj(),global=new Scope(null,true);
 const banned=new Set(['constructor','__proto__','prototype','caller','callee','eval','Function','process','require','fetch','document','window']);
 function tick(){if(++steps>limit||steps%1024===0&&Date.now()-start>45000)fatal('ast_budget_exceeded');}
 function guard(v){if(typeof v==='string'&&v.length>131072||Array.isArray(v)&&v.length>8192)fatal('ast_data_limit');return v;}
 function primitive(v){if(v!==null&&typeof v==='object')fatal('ast_object_coercion_unsupported');return v;}
 function string(v){return guard(String(primitive(v)));}
 function property(k){k=string(k);if(k.length>1024||banned.has(k))fatal('ast_property_forbidden');return k;}
 function own(a){let p=props.get(a);if(!p){p=new Map();props.set(a,p);}return p;}
 function getName(scope,name){tick();if(banned.has(name))fatal('ast_name_forbidden');const owner=scope.owner(name);if(!owner)fatal('ast_name_unavailable');let v=owner.p.get(name);if(v instanceof Lazy){if(v.busy)fatal('ast_cyclic_initializer');v.busy=true;v=expr(v.node,v.scope);owner.p.set(name,v);}return v;}
 function setName(scope,name,value,declare){if(banned.has(name))fatal('ast_name_forbidden');const owner=declare?scope:scope.owner(name);if(!owner)fatal('ast_undeclared_assignment');if(owner.p.size>8192)fatal('ast_data_limit');owner.p.set(name,guard(value));return value;}
 function read(obj,k){tick();k=property(k);
  if(obj instanceof Obj){if(obj.p.has(k))return obj.p.get(k);if(obj instanceof Fn&&['call','apply','bind','toString'].includes(k))return new Native('fn.'+k,obj);if(k==='hasOwnProperty')return new Native('own',obj);return undefined;}
  if(Array.isArray(obj)){if(k==='length')return obj.length;if(/^(0|[1-9][0-9]*)$/.test(k)){if(+k>=8192)fatal('ast_data_limit');return obj[+k];}if(own(obj).has(k))return own(obj).get(k);if(['push','shift','pop','unshift','join','slice','indexOf','includes','reverse'].includes(k))return new Native('array.'+k,obj);return undefined;}
  if(typeof obj==='string'){if(k==='length')return obj.length;if(/^(0|[1-9][0-9]*)$/.test(k))return obj[+k];if(['charAt','charCodeAt','indexOf','slice','substring','substr','split','toString','toLowerCase','replace','search'].includes(k))return new Native('string.'+k,obj);return undefined;}
  if(typeof obj==='number'&&k==='toString')return new Native('number.toString',obj);
  if(obj instanceof Native&&obj.name==='String'&&k==='fromCharCode')return new Native('fromCharCode');
  throw new Flow('throw','type_error');
 }
 function write(obj,k,value){tick();k=property(k);guard(value);
  if(obj instanceof Obj){if(obj.p.size>=8192&&!obj.p.has(k))fatal('ast_data_limit');obj.p.set(k,value);return value;}
  if(Array.isArray(obj)){if(k==='length'){if(!Number.isInteger(value)||value<0||value>8192)fatal('ast_data_limit');obj.length=value;}else if(/^(0|[1-9][0-9]*)$/.test(k)){if(+k>=8192)fatal('ast_data_limit');obj[+k]=value;}else{if(own(obj).size>=8192)fatal('ast_data_limit');own(obj).set(k,value);}return value;}
  fatal('ast_write_target_unsupported');
 }
 function binary(op,a,b){if(op==='===')return a===b;if(op==='!==')return a!==b;if(op==='in'){const k=property(a);return b instanceof Obj?b.p.has(k):Array.isArray(b)?Object.hasOwn(b,k)||own(b).has(k):false;}a=primitive(a);b=primitive(b);switch(op){case '+':return guard(a+b);case '-':return a-b;case '*':return a*b;case '/':return a/b;case '%':return a%b;case '^':return a^b;case '&':return a&b;case '|':return a|b;case '<<':return a<<b;case '>>':return a>>b;case '>>>':return a>>>b;case '==':return a==b;case '!=':return a!=b;case '<':return a<b;case '>':return a>b;case '<=':return a<=b;case '>=':return a>=b;default:fatal('ast_binary_unsupported');}}
 function ref(n,s){if(n.type==='Identifier')return {get:()=>getName(s,n.name),set:v=>setName(s,n.name,v)};if(n.type==='MemberExpression'){const o=expr(n.object,s),k=n.computed?expr(n.property,s):n.property.name;return {get:()=>read(o,k),set:v=>write(o,k,v)};}fatal('ast_reference_unsupported');}
 function hoist(body,s,lazy=false){for(const n of body){if(n.type==='FunctionDeclaration'){if(!n.id)fatal('ast_binding_unsupported');setName(s,n.id.name,new Fn(n,s),true);}else if(lazy&&n.type==='VariableDeclaration')for(const d of n.declarations){if(d.id.type!=='Identifier')fatal('ast_binding_unsupported');setName(s,d.id.name,d.init?new Lazy(d.init,s):undefined,true);}}}
 function hoistVars(node,s){const stack=[node];while(stack.length){const n=stack.pop();tick();if(n!==node&&/Function/.test(n.type))continue;if(n.type==='VariableDeclaration'&&n.kind==='var')for(const d of n.declarations){if(d.id.type!=='Identifier')fatal('ast_binding_unsupported');if(!s.p.has(d.id.name))setName(s,d.id.name,undefined,true);}for(const v of Object.values(n)){if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')stack.push(c);}else if(v&&typeof v.type==='string')stack.push(v);}}}
 function invoke(fn,args,thisValue){tick();if(depth++>=40)fatal('ast_call_depth');try{
  if(fn instanceof Native)return native(fn,args);
  if(!(fn instanceof Fn))throw new Flow('throw','type_error');const n=fn.node,s=new Scope(fn.scope,true);s.thisValue=thisValue===undefined?globalObject:thisValue;
  setName(s,'arguments',args.slice(),true);for(let i=0;i<n.params.length;i++){if(n.params[i].type!=='Identifier')fatal('ast_parameter_unsupported');setName(s,n.params[i].name,args[i],true);}
  if(n.type==='FunctionExpression'&&n.id&&!s.p.has(n.id.name))setName(s,n.id.name,fn,true);
  if(n.body.type!=='BlockStatement')return expr(n.body,s);hoist(n.body.body,s);hoistVars(n.body,s);
  try{for(const st of n.body.body)stmt(st,s);}catch(e){if(e instanceof Flow&&e.kind==='return')return e.value;throw e;}return undefined;
 }finally{depth--;}}
 function native(fn,a){const r=fn.receiver,name=fn.name;let v;
  try{
   if(name==='parseInt')return parseInt(string(a[0]),a[1]===undefined?undefined:Number(primitive(a[1])));
   if(name==='String')return string(a[0]);if(name==='Number')return Number(primitive(a[0]));if(name==='Boolean')return Boolean(a[0]);
   if(name==='decodeURIComponent')return guard(decodeURIComponent(string(a[0])));if(name==='encodeURIComponent')return guard(encodeURIComponent(string(a[0])));
   if(name==='fromCharCode'){if(a.length>1024)fatal('ast_data_limit');return String.fromCharCode(...a.map(x=>Number(primitive(x))));}
   if(name==='Array'){if(a.length===1&&typeof a[0]==='number'){if(!Number.isInteger(a[0])||a[0]<0||a[0]>8192)fatal('ast_data_limit');return Array(a[0]);}return guard(a.slice());}
   if(name==='Error'){const o=new Obj();o.p.set('message',string(a[0]));return o;}
   if(name==='own'){const k=property(a[0]);return r.p.has(k);}
   if(name==='fn.call')return invoke(r,a.slice(1),a[0]);if(name==='fn.apply'){if(!Array.isArray(a[1]))fatal('ast_apply_unsupported');return invoke(r,a[1],a[0]);}
   if(name==='fn.toString')return guard(source.slice(r.node.start,r.node.end));
   if(name==='fn.bind')fatal('ast_bind_unsupported');
   if(name.startsWith('array.')){const k=name.slice(6);if(['push','unshift'].includes(k)){if(r.length+a.length>8192)fatal('ast_data_limit');return k==='push'?r.push(...a):r.unshift(...a);}if(k==='shift')return r.shift();if(k==='pop')return r.pop();if(k==='reverse')return r.reverse();if(k==='join')return guard(r.map(x=>x==null?'':string(x)).join(a[0]===undefined?',':string(a[0])));if(k==='slice')return r.slice(...a.map(x=>Number(primitive(x))));if(k==='indexOf')return r.indexOf(a[0],a[1]);if(k==='includes')return r.includes(a[0],a[1]);}
   if(name==='number.toString')return guard(r.toString(a[0]===undefined?10:Number(primitive(a[0]))));
   if(name.startsWith('string.')){const k=name.slice(7);if(['charAt','charCodeAt','slice','substring','substr','indexOf'].includes(k)){const args=a.map(primitive);v=k==='charAt'?r.charAt(...args):k==='charCodeAt'?r.charCodeAt(...args):k==='slice'?r.slice(...args):k==='substring'?r.substring(...args):k==='substr'?r.substr(...args):r.indexOf(...args);return guard(v);}if(k==='toString')return r;if(k==='toLowerCase')return r.toLowerCase();if(k==='split'){v=r.split(a[0]===undefined?undefined:string(a[0]),8192);return guard(v);}if(k==='replace'){if(typeof a[0]!=='string'||typeof a[1]!=='string')fatal('ast_replace_unsupported');return guard(r.replace(a[0],a[1]));}if(k==='search')fatal('ast_regex_unsupported');}
  }catch(e){if(e instanceof Fatal||e instanceof Flow)throw e;throw new Flow('throw','native_data_error');}
  fatal('ast_native_unsupported');
 }
 function expr(n,s){tick();if(!n)return undefined;switch(n.type){
  case 'Literal':if(n.regex||typeof n.value==='bigint')fatal('ast_literal_unsupported');return guard(n.value);
  case 'Identifier':return getName(s,n.name);
  case 'ThisExpression':return s.thisValue;
  case 'ArrayExpression':if(n.elements.some(x=>x===null))fatal('ast_sparse_array_unsupported');if(n.elements.length>8192)fatal('ast_data_limit');return n.elements.map(x=>expr(x,s));
  case 'ObjectExpression':{if(++allocations>10000)fatal('ast_allocation_limit');const o=new Obj();for(const p of n.properties){if(p.type!=='Property'||p.kind!=='init'||p.method)fatal('ast_object_unsupported');const k=p.computed?expr(p.key,s):p.key.type==='Identifier'?p.key.name:p.key.value;write(o,k,expr(p.value,s));}return o;}
  case 'FunctionExpression':if(++allocations>10000)fatal('ast_allocation_limit');return new Fn(n,s);
  case 'ArrowFunctionExpression':fatal('ast_arrow_unsupported');
  case 'MemberExpression':return read(expr(n.object,s),n.computed?expr(n.property,s):n.property.name);
  case 'BinaryExpression':return binary(n.operator,expr(n.left,s),expr(n.right,s));
  case 'LogicalExpression':{const a=expr(n.left,s);if(n.operator==='||')return a||expr(n.right,s);if(n.operator==='&&')return a&&expr(n.right,s);if(n.operator==='??')return a==null?expr(n.right,s):a;fatal('ast_logical_unsupported');}
  case 'ConditionalExpression':return expr(expr(n.test,s)?n.consequent:n.alternate,s);
  case 'SequenceExpression':{let v;for(const x of n.expressions)v=expr(x,s);return v;}
  case 'UnaryExpression':{if(n.operator==='delete'){if(n.argument.type!=='MemberExpression')fatal('ast_delete_unsupported');const o=expr(n.argument.object,s),k=property(n.argument.computed?expr(n.argument.property,s):n.argument.property.name);if(o instanceof Obj)return o.p.delete(k);if(Array.isArray(o)){delete o[k];own(o).delete(k);return true;}fatal('ast_delete_unsupported');}const a=expr(n.argument,s);if(n.operator==='!')return !a;if(n.operator==='typeof')return a instanceof Fn||a instanceof Native?'function':typeof a;if(n.operator==='void')return undefined;if(n.operator==='+')return +primitive(a);if(n.operator==='-')return -primitive(a);if(n.operator==='~')return ~primitive(a);fatal('ast_unary_unsupported');}
  case 'AssignmentExpression':{const r=ref(n.left,s);if(n.operator==='=')return r.set(expr(n.right,s));return r.set(binary(n.operator.slice(0,-1),r.get(),expr(n.right,s)));}
  case 'UpdateExpression':{const r=ref(n.argument,s),v=Number(primitive(r.get())),next=n.operator==='++'?v+1:v-1;r.set(next);return n.prefix?next:v;}
  case 'CallExpression':case 'NewExpression':{let receiver,fn;if(n.callee.type==='MemberExpression'){receiver=expr(n.callee.object,s);fn=read(receiver,n.callee.computed?expr(n.callee.property,s):n.callee.property.name);}else fn=expr(n.callee,s);if(n.arguments.length>32||n.arguments.some(x=>x.type==='SpreadElement'))fatal('ast_arguments_unsupported');const a=n.arguments.map(x=>expr(x,s));if(n.type==='NewExpression'&&(!(fn instanceof Native)||!['Array','Error'].includes(fn.name)))fatal('ast_new_unsupported');return invoke(fn,a,receiver);}
  case 'TemplateLiteral':{let v=n.quasis[0].value.cooked;for(let i=0;i<n.expressions.length;i++)v=guard(v+string(expr(n.expressions[i],s))+n.quasis[i+1].value.cooked);return v;}
  default:fatal('ast_expression_'+n.type.toLowerCase());
 }}
 function stmt(n,s){tick();switch(n.type){
  case 'EmptyStatement':case 'FunctionDeclaration':return;
  case 'ExpressionStatement':expr(n.expression,s);return;
  case 'VariableDeclaration':for(const d of n.declarations){if(d.id.type!=='Identifier')fatal('ast_binding_unsupported');const target=n.kind==='var'?s.varScope():s;if(d.init||!target.p.has(d.id.name))setName(target,d.id.name,expr(d.init,s),true);}return;
  case 'BlockStatement':{const block=new Scope(s);hoist(n.body,block);for(const x of n.body)stmt(x,block);return;}
  case 'ReturnStatement':throw new Flow('return',expr(n.argument,s));
  case 'ThrowStatement':throw new Flow('throw',expr(n.argument,s));
  case 'IfStatement':if(expr(n.test,s))stmt(n.consequent,s);else if(n.alternate)stmt(n.alternate,s);return;
  case 'BreakStatement':case 'ContinueStatement':if(n.label)fatal('ast_label_unsupported');throw new Flow(n.type==='BreakStatement'?'break':'continue');
  case 'WhileStatement':case 'DoWhileStatement':{let first=true;while(n.type==='DoWhileStatement'&&first||expr(n.test,s)){first=false;try{stmt(n.body,s);}catch(e){if(e instanceof Flow&&e.kind==='break')break;if(!(e instanceof Flow&&e.kind==='continue'))throw e;}tick();}return;}
  case 'ForStatement':{const scope=new Scope(s);if(n.init){if(n.init.type==='VariableDeclaration')stmt(n.init,scope);else expr(n.init,scope);}while(!n.test||expr(n.test,scope)){try{stmt(n.body,scope);}catch(e){if(e instanceof Flow&&e.kind==='break')break;if(!(e instanceof Flow&&e.kind==='continue'))throw e;}if(n.update)expr(n.update,scope);tick();}return;}
  case 'TryStatement':{let pending;try{stmt(n.block,s);}catch(e){pending=e;}if(pending instanceof Fatal)throw pending;if(pending instanceof Flow&&pending.kind==='throw'&&n.handler){const c=new Scope(s);if(n.handler.param){if(n.handler.param.type!=='Identifier')fatal('ast_catch_unsupported');setName(c,n.handler.param.name,pending.value,true);}try{stmt(n.handler.body,c);pending=undefined;}catch(e){pending=e;}}if(pending instanceof Fatal)throw pending;if(n.finalizer)stmt(n.finalizer,s);if(pending)throw pending;return;}
  default:fatal('ast_statement_'+n.type.toLowerCase());
 }}
 for(const [k,v] of [['undefined',undefined],['NaN',NaN],['Infinity',Infinity]])global.p.set(k,v);
 for(const k of ['parseInt','String','Number','Boolean','decodeURIComponent','encodeURIComponent','Array','Error'])global.p.set(k,new Native(k));
 global.thisValue=globalObject;
 return {global,expr,hoist,Scope,Lazy,Fn,stats:()=>({steps,allocations})};
}
function recover(source,options={}){
 if(Buffer.byteLength(source,'utf8')>3000000)fatal('ast_input_limit');const hash=crypto.createHash('sha256').update(source).digest('hex');if(options.pin!==null&&hash!==PIN)fatal('ast_source_hash_changed');
 let ast;try{ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'});}catch(_){fatal('ast_parse_failed');}
 const parents=new WeakMap(),functions=new Map(),routes={main:[],dmca:[],rules:[]};
 walk(ast,n=>{for(const v of Object.values(n)){if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')parents.set(c,n);}else if(v&&typeof v.type==='string')parents.set(v,n);}if(n.type==='FunctionDeclaration'&&n.id){const list=functions.get(n.id.name)||[];list.push(n);functions.set(n.id.name,list);}if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'&&Object.hasOwn(routes,n.id.name))routes[n.id.name].push(n);});
 const roots=functions.get('_0x5447')||[];if(roots.length!==1||parents.get(roots[0])!==ast)fatal('ast_central_scope_unsupported');
 const tables=[];walk(roots[0].body,n=>{if(n.type!=='CallExpression'||n.callee.type!=='Identifier')return;const defs=functions.get(n.callee.name)||[];if(defs.length!==1||parents.get(defs[0])!==ast)return;let strings=false;walk(defs[0].body,a=>{if(a.type==='ArrayExpression'&&a.elements.length&&a.elements.every(x=>x&&x.type==='Literal'&&typeof x.value==='string'))strings=true;});if(strings&&!tables.includes(n.callee.name))tables.push(n.callee.name);});
 if(tables.length!==1)fatal('ast_table_not_unique');
 const rotations=[];walk(ast,n=>{if(n.type==='CallExpression'&&n.callee.type==='FunctionExpression'&&n.arguments.some(a=>a.type==='Identifier'&&a.name===tables[0]))rotations.push(n);});if(rotations.length!==1)fatal('ast_rotation_not_unique');
 for(const a of Object.values(routes))if(a.length!==1||!a[0].init||a[0].init.type!=='ArrayExpression'||a[0].start<rotations[0].end)fatal('ast_route_definition_unsupported');
 const m=machine(source,options.limit),scopes=new WeakMap([[ast,m.global]]);m.hoist(ast.body,m.global,true);
 function scopeFor(node){if(scopes.has(node))return scopes.get(node);let parent=parents.get(node);while(parent&&parent.type!=='BlockStatement'&&parent.type!=='Program')parent=parents.get(parent);if(!parent)fatal('ast_scope_unavailable');const outer=scopeFor(parent),owner=parents.get(node),isFn=owner&&/Function/.test(owner.type),scope=new m.Scope(outer,!!isFn);scopes.set(node,scope);if(isFn&&owner.params.length)fatal('ast_outer_parameters_unsupported');m.hoist(node.body,scope,true);return scope;}
 let rotationParent=parents.get(rotations[0]);while(rotationParent&&['ExpressionStatement','UnaryExpression','SequenceExpression'].includes(rotationParent.type))rotationParent=parents.get(rotationParent);if(rotationParent!==ast)fatal('ast_rotation_scope_unsupported');
 try{m.expr(rotations[0],m.global);}catch(e){if(e instanceof Fatal)throw e;fatal('ast_rotation_evaluation_failed');}
 const result={};for(const name of ['main','dmca','rules']){let block=parents.get(routes[name][0]);while(block&&block.type!=='BlockStatement'&&block.type!=='Program')block=parents.get(block);let data;try{data=m.expr(routes[name][0].init,scopeFor(block));}catch(e){if(e instanceof Fatal)throw e;fatal('ast_route_evaluation_failed');}if(!Array.isArray(data)||!data.length||data.length>100||!data.every(x=>typeof x==='string'&&x.length<=253&&/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(x)&&!/(?:^|\.)(?:local|localhost|internal|test|invalid|example)$/.test(x)))fatal('ast_route_domains_rejected');result[name]=[...new Set(data)];}
 return {status:'ast_route_candidates_recovered',main_script_sha256:hash,lists:result,limits:m.stats(),scope:'Selected table, decoder, rotation and route expressions modeled by a restricted AST interpreter. No eval, Function, DOM, network or host-system access from modeled code. Not playback or runtime-routing proof.'};
}
module.exports={recover,machine,Fatal};
if(require.main===module){try{process.stdout.write(JSON.stringify(recover(fs.readFileSync(0,'utf8'))));}catch(e){process.stdout.write(JSON.stringify({status:'unsupported',code:e instanceof Fatal&&/^ast_[a-z_]+$/.test(e.code)?e.code:'ast_interpretation_failed'}));process.exitCode=1;}}
