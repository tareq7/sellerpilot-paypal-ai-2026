import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalSandbox, SafeError, explainOrderWithModel, makeServer } from './index.mjs';
const response = (data, status=200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) });
test('does not issue OAuth token or order without approval', async () => {
  const calls=[];
  const client = new PayPalSandbox({ clientId:'id', clientSecret:'secret', fetcher: async (...a)=>{calls.push(a);return response({});} });
  await assert.rejects(client.createOrder({amount:'1.00',requestId:'test-order-0001',approved:false}), { status:403 });
  await assert.rejects(client.createOrder({amount:'1.000',requestId:'test-order-0001',approved:true}), { status:400 });
  assert.equal(calls.length,0);
});
test('uses sandbox OAuth and PayPal-Request-Id with real Orders API paths', async () => {
  const calls=[];let time=0;
  const fetcher=async (url,options)=>{calls.push({url,options});
    if(url.endsWith('/v1/oauth2/token'))return response({access_token:'mock-token',expires_in:3600});
    if(url.endsWith('/v2/checkout/orders'))return response({id:'9HX123456789',status:'CREATED',links:[{rel:'approve',href:'https://sandbox.paypal.com/approve'}]},201);
    return response({id:'9HX123456789',status:'APPROVED'});
  };
  const c=new PayPalSandbox({clientId:'id',clientSecret:'secret',fetcher,clock:()=>time});
  const order=await c.createOrder({amount:'1.00',requestId:'demo-order-2026',approved:true});
  assert.equal(order.status,'CREATED');
  assert.equal(calls[0].url,'https://api-m.sandbox.paypal.com/v1/oauth2/token');
  assert.equal(calls[1].options.headers['PayPal-Request-Id'],'demo-order-2026');
  assert.equal(JSON.parse(calls[1].options.body).purchase_units[0].amount.value,'1.00');
  await c.getOrder('9HX123456789');
  assert.equal(calls.filter(x=>x.url.endsWith('/v1/oauth2/token')).length,1);
});
test('denies capture until buyer approval; capture uses idempotency', async () => {
  let state='CREATED', calls=[];
  const fetcher=async (url,opts)=>{calls.push([url,opts]);if(url.endsWith('/token'))return response({access_token:'mock',expires_in:3600});
    if(url.endsWith('/capture'))return response({id:'9HX123456789',status:'COMPLETED'});
    return response({id:'9HX123456789',status:state});
  };
  const c=new PayPalSandbox({clientId:'id',clientSecret:'secret',fetcher});
  await assert.rejects(c.captureOrder({orderId:'9HX123456789',requestId:'capture-key-0001',approved:true}), {status:409});
  state='APPROVED';
  const result=await c.captureOrder({orderId:'9HX123456789',requestId:'capture-key-0001',approved:true});
  assert.equal(result.status,'COMPLETED');
  assert.equal(calls.at(-1)[1].headers['PayPal-Request-Id'],'capture-key-0001');
});
test('does not invent AI output when no model is configured', async () => {
  await assert.rejects(explainOrderWithModel({id:'9HX123',status:'CREATED'},{endpoint:'',key:'',model:''}), {status:503});
});
test('model explanation uses actual model output and limited order fields', async () => {
  let args;
  const result=await explainOrderWithModel({id:'9HX123',status:'CREATED',payer:{email_address:'secret@example.com'}},
    {endpoint:'https://example.invalid/v1/chat/completions',key:'test',model:'mock-model',fetcher:async (url,options)=>{args=options;return response({choices:[{message:{content:'Await buyer approval'}}]});}});
  assert.equal(result.explanation,'Await buyer approval');
  assert.equal(JSON.stringify(args.body).includes('secret@example.com'),false);
});
test('HTTP gateway requires approval token before PayPal calls', async () => {
  const server=makeServer({env:{API_APPROVAL_TOKEN:'01234567890123456789012345678901'},client:{createOrder:()=>{throw new Error('must not call')} }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const port=server.address().port;
    const r=await fetch('http://127.0.0.1:'+port+'/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"amount":"1.00"}'});
    assert.equal(r.status,401);
  }finally{await new Promise(r=>server.close(r));}
});