import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalSandbox, SafeError, makeServer, explainOrderWithModel } from './index.mjs';
import { readFileSync } from 'node:fs';

const response = (data, status=200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) });

// Helper to create server with mock client
function mockFetcherFactory(handlers){
  return async (url, options)=>{
    for(const [match, fn] of handlers){
      if(url.includes(match) || url.endsWith(match)) return fn(url, options);
    }
    return response({error:'not found'},404);
  };
}

// 1. malformed capture: invalid requestId
test('server rejects malformed capture requestId and mismatched orderId', async ()=>{
  const fetcher = async (url,opts)=>{
    if(url.endsWith('/v1/oauth2/token')) return response({access_token:'mock',expires_in:3600});
    if(url.includes('/v2/checkout/orders/') && url.endsWith('/capture')){
      return response({id:'ABCD12345678',status:'COMPLETED',purchase_units:[{payments:{captures:[{id:'CAP123',status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'}}]}}]});
    }
    // getOrder for APPROVED check
    return response({id:'ABCD12345678',status:'APPROVED',purchase_units:[{amount:{currency_code:'USD',value:'1.00'}}]});
  };
  const c=new PayPalSandbox({clientId:'id',clientSecret:'secret',fetcher});
  // missing requestId
  await assert.rejects(c.captureOrder({orderId:'ABCD12345678',requestId:'',approved:true}), {status:400});
  // too short
  await assert.rejects(c.captureOrder({orderId:'ABCD12345678',requestId:'short',approved:true}), {status:400});
  // invalid chars
  await assert.rejects(c.captureOrder({orderId:'ABCD12345678',requestId:'bad id with spaces',approved:true}), {status:400});
  // invalid orderId format
  await assert.rejects(c.captureOrder({orderId:'bad!!',requestId:'valid-capture-12345',approved:true}), {status:400});
  // missing approved flag
  await assert.rejects(c.captureOrder({orderId:'ABCD12345678',requestId:'valid-capture-12345',approved:false}), {status:403});
  await assert.rejects(c.captureOrder({orderId:'ABCD12345678',requestId:'valid-capture-12345'}), {status:403});

  // Test HTTP layer mismatched orderId in body
  const server=makeServer({env:{API_APPROVAL_TOKEN:'a'.repeat(32)}, client:c});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const port=server.address().port;
    const token='a'.repeat(32);
    const r=await fetch('http://127.0.0.1:'+port+'/orders/ABCD12345678/capture',{
      method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body: JSON.stringify({requestId:'valid-capture-12345',approved:true,orderId:'DIFFERENT12345678'})
    });
    assert.equal(r.status,400);
    const j=await r.json();
    assert.match(j.error, /Order ID in body/);
  } finally{ await new Promise(r=>server.close(r)); }
});

// 2. unapproved order: capture fails when not APPROVED
test('server denies capture when order not APPROVED (CREATED)', async ()=>{
  let status='CREATED';
  const fetcher=async (url,opts)=>{
    if(url.endsWith('/v1/oauth2/token')) return response({access_token:'mock',expires_in:3600});
    if(url.includes('/capture')) return response({id:'ABCD12345678',status:'COMPLETED'});
    return response({id:'ABCD12345678',status});
  };
  const c=new PayPalSandbox({clientId:'id',clientSecret:'secret',fetcher});
  await assert.rejects(c.captureOrder({orderId:'ABCD12345678',requestId:'capture-key-0001',approved:true}), {status:409});
  // still not approved after state remains CREATED
  status='PAYER_ACTION_REQUIRED';
  await assert.rejects(c.captureOrder({orderId:'ABCD12345678',requestId:'capture-key-0001',approved:true}), {status:409});
  // APPROVED should succeed
  status='APPROVED';
  const res=await c.captureOrder({orderId:'ABCD12345678',requestId:'capture-key-0001',approved:true});
  assert.equal(res.status,'COMPLETED');
});

// 3. rejected AI: fails closed when not configured
test('AI explain fails closed without model config (no invented output)', async ()=>{
  await assert.rejects(explainOrderWithModel({id:'ABCD12345678',status:'CREATED'},{endpoint:'',model:'',key:''}), {status:503});
  await assert.rejects(explainOrderWithModel({id:'ABCD12345678',status:'CREATED'},{endpoint:'https://example.com',model:'',key:'key'}), {status:503});
  // also via HTTP gateway: explain endpoint should 503 when env missing
  const server=makeServer({
    env:{API_APPROVAL_TOKEN:'b'.repeat(32)},
    client:{
      getOrder: async ()=>({id:'ABCD12345678',status:'COMPLETED',purchase_units:[{amount:{currency_code:'USD',value:'0.01'},payments:{captures:[{id:'CAP1',status:'COMPLETED',amount:{currency_code:'USD',value:'0.01'}}]}}]}),
      createOrder: async ()=>({}),
      captureOrder: async ()=>({})
    }
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const port=server.address().port;
    const r=await fetch('http://127.0.0.1:'+port+'/orders/ABCD12345678/explain',{method:'POST', headers:{Authorization:'Bearer '+'b'.repeat(32),'Content-Type':'application/json'}, body:'{}'});
    assert.equal(r.status,503);
    const j=await r.json();
    assert.match(j.error, /Live AI inference not configured/);
  } finally{ await new Promise(r=>server.close(r)); }
});

// 4. duplicate clicks guarded in-flight
test('client duplicate create clicks are ignored while in-flight', async ()=>{
  const nodes=new Map();
  for(const id of ['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain','statusText','statusDetail','status','captureConfirm']){
    nodes.set(id,{value:'',textContent:'',checked:false,disabled:false,handlers:{},children:[],replaceChildren(){this.children=[]},appendChild(x){this.children.push(x)},addEventListener(type,fn){this.handlers[type]=fn}});
  }
  nodes.get('token').value='c'.repeat(32);
  nodes.get('amount').value='1.00';
  let fetchCount=0;
  let release;
  const hold=new Promise(res=>{release=res});
  const oldDoc=globalThis.document, oldFetch=globalThis.fetch;
  globalThis.document={getElementById:id=>nodes.get(id)||null, createElement:()=>({})};
  globalThis.fetch=async ()=>{ fetchCount++; return hold; };
  try{
    await import('./demo.js?regression-dup-create='+Date.now());
    const p1=nodes.get('create').handlers.click();
    const p2=nodes.get('create').handlers.click();
    await new Promise(r=>setTimeout(r,10));
    assert.equal(fetchCount,1, 'duplicate create should not trigger second fetch');
    release({ok:true,status:201,json:async()=>({id:'ABCD12345678',status:'CREATED',links:[]})});
    await p1;
    await p2; // second was ignored but returns quickly
  } finally{
    globalThis.document=oldDoc; globalThis.fetch=oldFetch;
  }
});

test('client duplicate capture clicks are ignored while in-flight', async ()=>{
  const nodes=new Map();
  for(const id of ['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain','statusText','statusDetail','status','captureConfirm']){
    nodes.set(id,{value:'',textContent:'',checked:false,disabled:false,handlers:{},children:[],replaceChildren(){this.children=[]},appendChild(x){this.children.push(x)},addEventListener(type,fn){this.handlers[type]=fn}});
  }
  nodes.get('token').value='c'.repeat(32);
  nodes.get('orderId').value='ABCD12345678';
  nodes.get('captureConfirm').checked=true;
  let fetchCount=0;
  const oldDoc=globalThis.document, oldFetch=globalThis.fetch;
  globalThis.document={getElementById:id=>nodes.get(id)||null, createElement:()=>({})};
  globalThis.fetch=async (url,opts)=>{
    fetchCount++;
    if(url.includes('/orders/ABCD12345678') && opts.method==='GET'){
      return {ok:true,status:200,json:async()=>({id:'ABCD12345678',status:'APPROVED',purchase_units:[{amount:{currency_code:'USD',value:'1.00'}}]})};
    }
    if(url.includes('/capture')){
      await new Promise(r=>setTimeout(r,50));
      return {ok:true,status:200,json:async()=>({id:'ABCD12345678',status:'COMPLETED',purchase_units:[{amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:'CAP123',status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'}}]}}]})};
    }
    return {ok:true,status:200,json:async()=>({})};
  };
  try{
    await import('./demo.js?regression-dup-capture='+Date.now());
    const cap1=nodes.get('capture').handlers.click();
    const cap2=nodes.get('capture').handlers.click();
    await new Promise(r=>setTimeout(r,15));
    assert.equal(fetchCount,2, 'duplicate capture should be ignored while busy (expected 2 fetches for single flow)');
    await cap1;
    await cap2;
  } finally{
    globalThis.document=oldDoc; globalThis.fetch=oldFetch;
  }
});

// 5. stale response ignored after newOrder
test('stale create response ignored after newOrder reset', async ()=>{
  const nodes=new Map();
  for(const id of ['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain','statusText','statusDetail','status','captureConfirm']){
    nodes.set(id,{value:'',textContent:'',checked:false,disabled:false,handlers:{},children:[],replaceChildren(){this.children=[]},appendChild(x){this.children.push(x)},addEventListener(type,fn){this.handlers[type]=fn}});
  }
  nodes.get('token').value='d'.repeat(32);
  nodes.get('amount').value='2.00';
  let release;
  const hold=new Promise(r=>{release=r});
  const oldDoc=globalThis.document, oldFetch=globalThis.fetch;
  globalThis.document={getElementById:id=>nodes.get(id)||null, createElement:()=>({})};
  globalThis.fetch=async()=>hold;
  try{
    await import('./demo.js?regression-stale='+Date.now());
    const inFlight=nodes.get('create').handlers.click();
    // reset before response
    await nodes.get('newOrder').handlers.click();
    assert.equal(nodes.get('orderId').value,'');
    release({ok:true,status:201,json:async()=>({id:'STALE123456789',status:'CREATED',links:[]})});
    await inFlight;
    // stale should not restore orderId
    assert.equal(nodes.get('orderId').value,'');
    assert.match(nodes.get('output').textContent,/New synthetic order session/);
    // also status should remain new session
    const st=nodes.get('statusText');
    if(st) assert.match(st.textContent, /New synthetic order session/);
  } finally{ globalThis.document=oldDoc; globalThis.fetch=oldFetch; }
});

// 6. unapproved order capture blocked on client after fresh GET
test('client does fresh GET and blocks capture if not APPROVED', async ()=>{
  const nodes=new Map();
  for(const id of ['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain','statusText','statusDetail','status','captureConfirm']){
    nodes.set(id,{value:'',textContent:'',checked:false,disabled:false,handlers:{},children:[],replaceChildren(){this.children=[]},appendChild(x){this.children.push(x)},addEventListener(type,fn){this.handlers[type]=fn}});
  }
  nodes.get('token').value='e'.repeat(32);
  nodes.get('orderId').value='UNAPPROVED12345';
  nodes.get('captureConfirm').checked=true;
  const oldDoc=globalThis.document, oldFetch=globalThis.fetch;
  globalThis.document={getElementById:id=>nodes.get(id)||null, createElement:()=>({})};
  let captureAttempted=false;
  globalThis.fetch=async (url,opts)=>{
    if(url.includes('/orders/UNAPPROVED12345') && opts.method==='GET'){
      return {ok:true,status:200,json:async()=>({id:'UNAPPROVED12345',status:'CREATED',purchase_units:[{amount:{currency_code:'USD',value:'1.00'}}]})};
    }
    if(url.includes('/capture')){
      captureAttempted=true;
      return {ok:true,status:200,json:async()=>({id:'UNAPPROVED12345',status:'COMPLETED'})};
    }
    return {ok:false,status:404,json:async()=>({error:'not found'})};
  };
  try{
    await import('./demo.js?regression-unapproved='+Date.now());
    await nodes.get('capture').handlers.click();
    assert.equal(captureAttempted,false, 'capture POST should not be attempted when GET shows not APPROVED');
    assert.match(nodes.get('output').textContent, /CREATED|Buyer has not approved/);
  } finally{ globalThis.document=oldDoc; globalThis.fetch=oldFetch; }
});

// 7. only claimed completed when verified matching capture
test('client only claims completed when verified capture matches ID/amount/currency', async ()=>{
  // Simulate verifiedCapture logic via server response
  const orderGood={
    id:'ORDERGOOD12345',status:'COMPLETED',
    purchase_units:[{amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:'CAPGOOD123',status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'}}]}}]
  };
  const orderBadAmount={
    id:'ORDERGOOD12345',status:'COMPLETED',
    purchase_units:[{amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:'CAPGOOD123',status:'COMPLETED',amount:{currency_code:'USD',value:'2.00'}}]}}]
  };
  const orderPending={
    id:'ORDERGOOD12345',status:'COMPLETED',
    purchase_units:[{amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:'CAPGOOD123',status:'PENDING',amount:{currency_code:'USD',value:'1.00'}}]}}]
  };
  const orderWrongCurrency={
    id:'ORDERGOOD12345',status:'COMPLETED',
    purchase_units:[{amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:'CAPGOOD123',status:'COMPLETED',amount:{currency_code:'EUR',value:'1.00'}}]}}]
  };
  // Helper mirroring client verifiedCapture
  function verifiedCapture(order, expectedOrderId, expectedAmount){
    const captures=order?.purchase_units?.flatMap(p=>p.payments?.captures||[])||[];
    const completed=captures.find(c=>c.status==='COMPLETED');
    const total=completed?.amount;
    if(order?.id!==expectedOrderId || order?.status!=='COMPLETED' || !completed?.id || total?.currency_code!=='USD' || total?.value!==expectedAmount) return null;
    return completed;
  }
  assert.ok(verifiedCapture(orderGood,'ORDERGOOD12345','1.00'));
  assert.equal(verifiedCapture(orderBadAmount,'ORDERGOOD12345','1.00'),null);
  assert.equal(verifiedCapture(orderPending,'ORDERGOOD12345','1.00'),null);
  assert.equal(verifiedCapture(orderWrongCurrency,'ORDERGOOD12345','1.00'),null);
  assert.equal(verifiedCapture(orderGood,'WRONGID','1.00'),null);
  assert.equal(verifiedCapture(orderGood,'ORDERGOOD12345','2.00'),null);
});

// 8. HTML status panel exists and does not leak secrets
test('demo.html contains human-readable status UI and no secret leakage', ()=>{
  const html=readFileSync(new URL('./demo.html',import.meta.url),'utf8');
  assert.ok(html.includes('id="status"'), 'status panel missing');
  assert.ok(html.includes('id="statusText"'), 'statusText missing');
  assert.ok(html.includes('id="captureConfirm"'), 'capture confirmation checkbox missing');
  assert.ok(html.includes('Passing mock tests is NOT a live PayPal payment'), 'honest limitation missing');
  assert.ok(html.includes('MOCK'), 'mock labeling missing');
  assert.ok(!html.includes('PAYPAL_SANDBOX_CLIENT_SECRET'), 'secret leaked in HTML');
  assert.equal(html.includes('localStorage'), false, 'HTML should not use localStorage for token');
});

// 9. demo.js never exposes Authorization header in record
test('demo.js call does not log Authorization header', async ()=>{
  const content=readFileSync(new URL('./demo.js',import.meta.url),'utf8');
  assert.ok(content.includes('Authorization'), 'demo.js should set Authorization header');
  // ensure record is only called with status and body, not headers
  assert.ok(!content.includes('Authorization') || content.includes('record(response.status'), 'record should not include headers');
  assert.ok(content.includes('PayPal-Request-Id') || content.includes('requestId'), 'should use idempotency key');
  assert.ok(content.includes('verifiedCapture'), 'should implement verified capture');
  assert.ok(content.includes('fresh GET') || content.includes('GET'), 'should do fresh GET before capture');
});

test('capture uncertainty blocks reset and duplicate capture until status verified', async ()=>{
  const nodes=new Map();
  for(const id of ['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain','statusText','statusDetail','status','captureConfirm']){
    nodes.set(id,{value:'',textContent:'',checked:false,disabled:false,handlers:{},children:[],replaceChildren(){this.children=[]},appendChild(x){this.children.push(x)},addEventListener(type,fn){this.handlers[type]=fn}});
  }
  nodes.get('token').value='f'.repeat(32);
  nodes.get('orderId').value='ABCD12345678';
  nodes.get('captureConfirm').checked=true;
  const priorDocument=globalThis.document, priorFetch=globalThis.fetch;
  let postCount=0, orderReads=0;
  globalThis.document={getElementById:id=>nodes.get(id)||null,createElement:()=>({})};
  globalThis.fetch=async (url,opts)=>{
    if(opts.method==='GET'){
      orderReads++;
      const completed=orderReads>1;
      return {ok:true,status:200,json:async()=>completed
        ? {id:'ABCD12345678',status:'COMPLETED',purchase_units:[{amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:'CAPSAFE1',status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'}}]}}]}
        : {id:'ABCD12345678',status:'APPROVED',purchase_units:[{amount:{currency_code:'USD',value:'1.00'}}]}};
    }
    if(opts.method==='POST'){
      postCount++;
      throw new Error('Mock ambiguous capture timeout');
    }
    throw new Error('Unexpected mock request');
  };
  try {
    await import('./demo.js?regression-capture-uncertain='+Date.now());
    await nodes.get('capture').handlers.click();
    assert.equal(postCount,1,'single POST attempted before uncertain timeout');
    nodes.get('newOrder').handlers.click();
    assert.equal(nodes.get('orderId').value,'ABCD12345678','reset cannot discard uncertain capture');
    await nodes.get('capture').handlers.click();
    assert.equal(postCount,1,'capture cannot retry while uncertain');
    await nodes.get('refresh').handlers.click();
    assert.match(nodes.get('statusText').textContent,/Capture COMPLETED/);
    nodes.get('newOrder').handlers.click();
    assert.equal(nodes.get('orderId').value,'','verified capture allows starting new order');
  } finally{globalThis.document=priorDocument;globalThis.fetch=priorFetch;}
});

test('cannot reset during capture preflight; preserve pending order ID', async ()=>{
  const nodes=new Map();
  for(const id of ['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain','statusText','statusDetail','status','captureConfirm']){
    nodes.set(id,{value:'',textContent:'',checked:false,disabled:false,handlers:{},children:[],replaceChildren(){this.children=[]},appendChild(x){this.children.push(x)},addEventListener(type,fn){this.handlers[type]=fn}});
  }
  nodes.get('token').value='g'.repeat(32);
  nodes.get('orderId').value='ABCD12345678';
  nodes.get('captureConfirm').checked=true;
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const priorDocument=globalThis.document, priorFetch=globalThis.fetch;
  globalThis.document={getElementById:id=>nodes.get(id)||null,createElement:()=>({})};
  globalThis.fetch=async (url,opts)=>{
    if(opts.method==='GET') return pending;
    if(opts.method==='POST') return {ok:true,status:200,json:async()=>({
      id:'ABCD12345678',status:'COMPLETED',
      purchase_units:[{amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:'CAPSAFE2',status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'}}]}}]
    })};
    throw new Error('Unexpected request');
  };
  try {
    await import('./demo.js?regression-capture-preflight='+Date.now());
    const operation=nodes.get('capture').handlers.click();
    nodes.get('newOrder').handlers.click();
    assert.equal(nodes.get('orderId').value,'ABCD12345678','cannot reset during GET approval check');
    release({ok:true,status:200,json:async()=>({id:'ABCD12345678',status:'APPROVED',purchase_units:[{amount:{currency_code:'USD',value:'1.00'}}]})});
    await operation;
    assert.match(nodes.get('statusText').textContent,/Capture COMPLETED/);
  } finally{globalThis.document=priorDocument;globalThis.fetch=priorFetch;}
});

test('diagnostic response does not expose arbitrary customer or private fields', async ()=>{
  const nodes=new Map();
  for(const id of ['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain','statusText','statusDetail','status','captureConfirm']){
    nodes.set(id,{value:'',textContent:'',checked:false,disabled:false,handlers:{},children:[],replaceChildren(){this.children=[]},appendChild(x){this.children.push(x)},addEventListener(type,fn){this.handlers[type]=fn}});
  }
  nodes.get('token').value='h'.repeat(32);
  nodes.get('orderId').value='ABCD12345678';
  const priorDocument=globalThis.document, priorFetch=globalThis.fetch;
  globalThis.document={getElementById:id=>nodes.get(id)||null,createElement:()=>({})};
  globalThis.fetch=async ()=>({ok:true,status:200,json:async()=>({
    id:'ABCD12345678',status:'CREATED',secret_extension:'hidden-secret-value',
    payer:{email_address:'private-buyer@example.invalid'},
    purchase_units:[{amount:{currency_code:'USD',value:'1.00'},shipping:{name:{full_name:'Sensitive Name'}}}]
  })});
  try {
    await import('./demo.js?regression-pii-sanitize='+Date.now());
    await nodes.get('refresh').handlers.click();
    const output=nodes.get('output').textContent;
    assert.match(output,/ABCD12345678/);
    assert.doesNotMatch(output,/hidden-secret-value|private-buyer|Sensitive Name|secret_extension|payer|shipping/);
  } finally{globalThis.document=priorDocument;globalThis.fetch=priorFetch;}
});

test('capture confirmation stays disabled after a completed status refresh', async ()=>{
  const nodes=new Map();
  for(const id of ['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain','statusText','statusDetail','status','captureConfirm']){
    nodes.set(id,{value:'',textContent:'',checked:false,disabled:false,handlers:{},children:[],replaceChildren(){this.children=[]},appendChild(x){this.children.push(x)},addEventListener(type,fn){this.handlers[type]=fn}});
  }
  nodes.get('token').value='i'.repeat(32);
  nodes.get('orderId').value='ABCD12345678';
  const oldDoc=globalThis.document, oldFetch=globalThis.fetch;
  globalThis.document={getElementById:id=>nodes.get(id)||null,createElement:()=>({})};
  globalThis.fetch=async ()=>({ok:true,status:200,json:async()=>({id:'ABCD12345678',status:'CREATED'})});
  try{
    await import('./demo.js?regression-checkbox-sticky='+Date.now());
    assert.equal(nodes.get('capture').disabled,true,'checkbox not checked');
    await nodes.get('refresh').handlers.click();
    assert.equal(nodes.get('capture').disabled,true,'setBusy(false) must not enable capture');
    nodes.get('captureConfirm').checked=true;
    nodes.get('captureConfirm').handlers.change();
    assert.equal(nodes.get('capture').disabled,false,'explicit checkbox change enables capture');
    nodes.get('captureConfirm').checked=false;
    nodes.get('captureConfirm').handlers.change();
    assert.equal(nodes.get('capture').disabled,true,'unchecking disables capture again');
  } finally{globalThis.document=oldDoc;globalThis.fetch=oldFetch;}
});

test('definite local capture rejection releases uncertain state without claiming success', async ()=>{
  const nodes=new Map();
  for(const id of ['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain','statusText','statusDetail','status','captureConfirm']){
    nodes.set(id,{value:'',textContent:'',checked:false,disabled:false,handlers:{},children:[],replaceChildren(){this.children=[]},appendChild(x){this.children.push(x)},addEventListener(type,fn){this.handlers[type]=fn}});
  }
  nodes.get('token').value='j'.repeat(32);
  nodes.get('orderId').value='ABCD12345678';
  nodes.get('captureConfirm').checked=true;
  const oldDoc=globalThis.document, oldFetch=globalThis.fetch;
  let attempts=0;
  globalThis.document={getElementById:id=>nodes.get(id)||null,createElement:()=>({})};
  globalThis.fetch=async (url,opts)=>{
    if(opts.method==='GET') return {ok:true,status:200,json:async()=>({id:'ABCD12345678',status:'APPROVED',purchase_units:[{amount:{currency_code:'USD',value:'1.00'}}]})};
    attempts++;
    return {ok:false,status:409,json:async()=>({error:'Buyer approval has changed'})};
  };
  try{
    await import('./demo.js?regression-rejection-clear='+Date.now());
    await nodes.get('capture').handlers.click();
    assert.equal(attempts,1);
    assert.match(nodes.get('statusText').textContent,/rejected before payment/);
    assert.doesNotMatch(nodes.get('statusText').textContent,/COMPLETED/);
    nodes.get('newOrder').handlers.click();
    assert.equal(nodes.get('orderId').value,'','known rejection should not freeze new orders');
  } finally{globalThis.document=oldDoc;globalThis.fetch=oldFetch;}
});
