/* Restricted forwarding-call normalization. Never invokes source functions. */
'use strict';
const ROOT='_0x5447',MAX=100000;
function walk(root,visit){const stack=[root],seen=new WeakSet();let count=0;while(stack.length){const n=stack.pop();if(!n||typeof n!=='object'||seen.has(n))continue;seen.add(n);if(++count>MAX)throw Error('ast_limit');if(n.type)visit(n);for(const[key,value]of Object.entries(n)){if(['raw','start','end','loc','range'].includes(key))continue;if(Array.isArray(value)){for(const x of value)if(x&&typeof x==='object')stack.push(x);}else if(value&&typeof value==='object')stack.push(value);}}}
function primitive(v){return v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&v.length<=8192;}
function constant(n,env,depth=0){
  if(!n||depth>16)throw Error('nonconstant');
  let v;
  if(n.type==='Literal'&&primitive(n.value))v=n.value;
  else if(n.type==='Identifier'&&env.has(n.name))v=env.get(n.name);
  else if(n.type==='UnaryExpression'){
    const a=constant(n.argument,env,depth+1);
    if(n.operator==='-')v=-a;else if(n.operator==='+')v=+a;else if(n.operator==='~')v=~a;else if(n.operator==='!')v=!a;else throw Error('nonconstant');
  }else if(n.type==='BinaryExpression'){
    const a=constant(n.left,env,depth+1),b=constant(n.right,env,depth+1);
    switch(n.operator){case '+':v=a+b;break;case '-':v=a-b;break;case '*':v=a*b;break;case '/':v=a/b;break;case '%':v=a%b;break;case '^':v=a^b;break;case '&':v=a&b;break;case '|':v=a|b;break;case '<<':v=a<<b;break;case '>>':v=a>>b;break;case '>>>':v=a>>>b;break;default:throw Error('nonconstant');}
  }else throw Error('nonconstant');
  if(!primitive(v))throw Error('nonconstant');return v;
}
function safeReturn(n,params){if(!n)return false;if(n.type==='Literal')return primitive(n.value);if(n.type==='Identifier')return params.has(n.name);if(n.type==='UnaryExpression')return['-','+','~','!'].includes(n.operator)&&safeReturn(n.argument,params);if(n.type==='BinaryExpression')return['+','-','*','/','%','^','&','|','<<','>>','>>>'].includes(n.operator)&&safeReturn(n.left,params)&&safeReturn(n.right,params);return false;}
function forwarding(ast){
  const declarations=new Map(),otherBindings=new Map(),assigned=new Set(),functions=[];
  function add(map,k){map.set(k,(map.get(k)||0)+1);}
  walk(ast,n=>{
    if(n.type==='FunctionDeclaration'&&n.id){add(declarations,n.id.name);functions.push(n);}
    if(n.type==='VariableDeclarator'&&n.id.type==='Identifier')add(otherBindings,n.id.name);
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(n.type))for(const p of n.params||[])if(p.type==='Identifier')add(otherBindings,p.name);
    if(n.type==='AssignmentExpression'&&n.left.type==='Identifier')assigned.add(n.left.name);
  });
  const candidates=new Map();if(declarations.get(ROOT)!==1||otherBindings.has(ROOT))return candidates;
  for(const fn of functions){
    if(fn.id.name===ROOT||declarations.get(fn.id.name)!==1||otherBindings.has(fn.id.name)||assigned.has(fn.id.name)||!fn.params.length||fn.params.length>5||fn.params.some(p=>p.type!=='Identifier'))continue;
    if(fn.body.body.length!==1||fn.body.body[0].type!=='ReturnStatement')continue;
    const call=fn.body.body[0].argument,params=new Set(fn.params.map(p=>p.name));
    if(!call||call.type!=='CallExpression'||call.callee.type!=='Identifier'||call.callee.name!==ROOT||call.arguments.length!==2||!call.arguments.every(n=>safeReturn(n,params)))continue;
    candidates.set(fn.id.name,{params:fn.params.map(p=>p.name),arguments:call.arguments});
  }
  return candidates;
}
function literal(v){if(typeof v==='number'&&(v<0||Object.is(v,-0)))return{type:'UnaryExpression',operator:'-',prefix:true,argument:{type:'Literal',value:-v}};return{type:'Literal',value:v};}
function normalize(ast){
  const candidates=forwarding(ast);let inlined=0,skipped=0;
  walk(ast,n=>{
    if(n.type!=='CallExpression'||n.callee.type!=='Identifier'||!candidates.has(n.callee.name))return;
    const fn=candidates.get(n.callee.name);if(n.arguments.length!==fn.params.length){skipped++;return;}
    try{
      const values=n.arguments.map(a=>constant(a,new Map())),env=new Map(fn.params.map((p,i)=>[p,values[i]]));
      const args=fn.arguments.map(a=>literal(constant(a,env)));
      n.callee={type:'Identifier',name:ROOT};n.arguments=args;inlined++;
    }catch(_){skipped++;}
  });
  return{method:'AST-only substitution of single-return forwarding functions with constant primitive arguments. Source functions were not invoked.',root:ROOT,eligible_forwarding_functions:candidates.size,calls_inlined:inlined,calls_skipped:skipped};
}
function inspectAst(ast){const routes={main:[],dmca:[],rules:[]};let rootCalls=0;walk(ast,n=>{if(n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.callee.name===ROOT)rootCalls++;let id,value;if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'){id=n.id.name;value=n.init;}else if(n.type==='AssignmentExpression'&&n.left.type==='Identifier'){id=n.left.name;value=n.right;}if(Object.hasOwn(routes,id)&&value&&routes[id].length<3)routes[id].push({type:value.type,elements:value.type==='ArrayExpression'?value.elements.length:null});});return{root:ROOT,root_call_count:rootCalls,forwarding_function_count:forwarding(ast).size,routes};}
function selfTest(){
  const a=require('node:assert/strict'),id=name=>({type:'Identifier',name}),lit=value=>({type:'Literal',value}),binary=(operator,left,right)=>({type:'BinaryExpression',operator,left,right});
  const root={type:'FunctionDeclaration',id:id(ROOT),params:[id('index'),id('key')],body:{type:'BlockStatement',body:[]}};
  const wrapper={type:'FunctionDeclaration',id:id('bridge'),params:[id('a'),id('b'),id('c'),id('d'),id('e')],body:{type:'BlockStatement',body:[{type:'ReturnStatement',argument:{type:'CallExpression',callee:id(ROOT),arguments:[binary('-',id('b'),lit(436)),id('d')]}}]}};
  function program(args){const call={type:'CallExpression',callee:id('bridge'),arguments:args};return{ast:{type:'Program',body:[JSON.parse(JSON.stringify(root)),JSON.parse(JSON.stringify(wrapper)),{type:'ExpressionStatement',expression:call}]},call};}
  let passed=0;
  let p=program([lit(0),lit(500),lit(0),lit('private-key'),lit(0)]),s=normalize(p.ast);a.equal(s.calls_inlined,1);a.equal(p.call.callee.name,ROOT);passed++;
  a.equal(p.call.arguments[0].value,64);a.equal(p.call.arguments[1].value,'private-key');passed++;
  p=program([lit(0),{type:'UnaryExpression',operator:'-',argument:lit(3)},lit(0),lit('k'),lit(0)]);normalize(p.ast);a.equal(constant(p.call.arguments[0],new Map()),-439);passed++;
  p=program([lit(0),{type:'CallExpression',callee:id('unsafe'),arguments:[]},lit(0),lit('k'),lit(0)]);a.equal(normalize(p.ast).calls_inlined,0);passed++;
  p=program([lit(0),lit(500),lit(0),lit('k'),lit(0)]);p.ast.body[1].body.body.unshift({type:'ExpressionStatement',expression:{type:'CallExpression',callee:id('unsafe'),arguments:[]}});a.equal(normalize(p.ast).calls_inlined,0);passed++;
  p=program([lit(0),lit(500),lit(0),lit('k'),lit(0)]);p.ast.body.push({type:'AssignmentExpression',operator:'=',left:id('bridge'),right:id('other')});a.equal(normalize(p.ast).calls_inlined,0);passed++;
  p=program([lit(0),lit(500),lit(0),lit('k'),lit(0)]);p.ast.body.push(JSON.parse(JSON.stringify(wrapper)));a.equal(normalize(p.ast).calls_inlined,0);passed++;
  p=program([lit(0)]);a.equal(normalize(p.ast).calls_inlined,0);passed++;
  a.equal(constant(binary('+',lit('a'),lit('b')),new Map()),'ab');passed++;
  a.throws(()=>constant(binary('/',lit(1),lit(0)),new Map()));passed++;
  const text=JSON.stringify(inspectAst(program([lit('secret')]).ast));a.ok(!text.includes('secret'));passed++;
  a.equal(constant(binary('>>>',lit(-1),lit(0)),new Map()),4294967295);passed++;
  return{passed,total:12,scope:'Synthetic AST normalization only; central decoder and live source not executed.'};
}
module.exports={inspectAst,normalize,selfTest};
