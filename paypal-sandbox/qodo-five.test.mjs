import test from 'node:test';
import assert from 'node:assert/strict';

const IDS=['output','token','amount','orderId','approvalLink','create','newOrder','refresh','capture','explain','statusText','statusDetail','status','captureConfirm'];
let instance=0;
function setup(orderId='ORDERAAA12345'){
  const nodes=new Map(IDS.map(id=>[id,{
    value:'',textContent:'',className:'',disabled:false,checked:false,handlers:{},children:[],
    replaceChildren(){this.children=[]},appendChild(n){this.children.push(n)},
    addEventListener(k,fn){this.handlers[k]=fn}
  }]));
  nodes.get('token').value='k'.repeat(32);
  nodes.get('orderId').value=orderId;
  nodes.get('amount').value='1.00';
  const previous={document:globalThis.document,fetch:globalThis.fetch};
  globalThis.document={getElementById:id=>nodes.get(id)||null,createElement:()=>({})};
  return {
    n:id=>nodes.get(id),
    event:(id,type='click')=>nodes.get(id).handlers[type](),
    async load(){await import('./demo.js?qodo-five='+ ++instance);},
    restore(){globalThis.document=previous.document;globalThis.fetch=previous.fetch;}
  };
}
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const approved=id=>({id,status:'APPROVED',purchase_units:[{amount:{currency_code:'USD',value:'1.00'}}]});
const completed=id=>({id,status:'COMPLETED',purchase_units:[{amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:'CAPTURE123',status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'}}]}}]});
const confirm=h=>{h.n('captureConfirm').checked=true;h.event('captureConfirm','change');};

test('uncertain capture requires same-order APPROVED recheck and reuses request ID',async()=>{
  const h=setup();let posts=[];let reads=0;
  globalThis.fetch=async (url,opts)=>{
    if(opts.method==='GET'){reads++;return response(approved('ORDERAAA12345'));}
    if(url.endsWith('/capture')){posts.push(JSON.parse(opts.body).requestId);if(posts.length===1)throw Error('ambiguous timeout');return response(completed('ORDERAAA12345'));}
    throw Error('unexpected route');
  };
  try{
    await h.load();confirm(h);
    await h.event('capture');
    assert.equal(posts.length,1);
    h.event('newOrder');assert.equal(h.n('orderId').value,'ORDERAAA12345');
    await h.event('capture');assert.equal(posts.length,1,'no blind retry');
    await h.event('refresh');
    assert.match(h.n('statusText').textContent,/deliberate retry allowed/);
    assert.equal(h.n('capture').disabled,true,'new human confirmation is required');
    confirm(h);
    assert.equal(h.n('capture').disabled,false);
    await h.event('capture');
    assert.equal(posts.length,2);
    assert.equal(posts[0],posts[1],'original PayPal-Request-Id must be reused');
    assert.ok(reads>=3,'each capture attempt must freshly check approval');
    assert.match(h.n('statusText').textContent,/Capture COMPLETED/);
    h.event('newOrder');assert.equal(h.n('orderId').value,'');
  }finally{h.restore();}
});

test('an alternate order cannot resolve an unrelated uncertain capture',async()=>{
  const h=setup();let postCount=0,readCount=0;
  globalThis.fetch=async(url,opts)=>{
    if(opts.method==='GET'){readCount++;return response(url.includes('ORDERBBB12345')?completed('ORDERBBB12345'):approved('ORDERAAA12345'));}
    if(opts.method==='POST'){postCount++;throw Error('ambiguous timeout');}
    throw Error('unexpected route');
  };
  try{
    await h.load();confirm(h);await h.event('capture');
    assert.equal(postCount,1);
    h.n('orderId').value='ORDERBBB12345';h.event('orderId','input');
    await h.event('refresh');
    assert.match(h.n('statusText').textContent,/Unresolved capture for ORDERAAA12345/);
    assert.equal(readCount,1,'do not request a different order while original is uncertain');
    h.event('newOrder');assert.equal(h.n('orderId').value,'ORDERBBB12345','reset blocked for all edited order IDs');
    confirm(h);await h.event('capture');
    assert.equal(postCount,1,'cannot capture a different order while uncertain');
  }finally{h.restore();}
});

test('order-ID edit revokes old capture confirmation',async()=>{
  const h=setup();let postCount=0;
  globalThis.fetch=async(url,opts)=>{
    if(opts.method==='GET')return response(approved('ORDERBBB12345'));
    postCount++;return response(completed('ORDERBBB12345'));
  };
  try{
    await h.load();confirm(h);
    h.n('orderId').value='ORDERBBB12345';h.event('orderId','input');
    assert.equal(h.n('captureConfirm').checked,false);
    assert.equal(h.n('capture').disabled,true);
    await h.event('capture');assert.equal(postCount,0);
    confirm(h);await h.event('capture');assert.equal(postCount,1,'explicit confirmation for B permits B');
  }finally{h.restore();}
});

test('live AI explanation is displayed with bounded allowlist, without private fields',async()=>{
  const h=setup();const secret='private-buyer@example.invalid';
  globalThis.fetch=async()=>response({
    explanation:'Useful result: '+('x'.repeat(9000)),model:'example-model',
    order:{id:'ORDERAAA12345',status:'APPROVED',amount:{currency_code:'USD',value:'1.00'},payer:{email_address:secret}},
    secret_extension:secret
  });
  try{
    await h.load();await h.event('explain');
    const output=h.n('output').textContent;
    assert.match(output,/Useful result/);
    assert.match(output,/example-model/);
    assert.match(output,/ORDERAAA12345/);
    assert.doesNotMatch(output,/private-buyer|secret_extension|payer/);
    assert.ok(output.length<9000,'explanation is bounded');
  }finally{h.restore();}
});

test('stale status and explanation responses do not overwrite newly selected order',async()=>{
  for(const operation of ['refresh','explain']){
    const h=setup();let release;
    const pending=new Promise(resolve=>release=resolve);
    globalThis.fetch=async()=>pending;
    try{
      await h.load();
      const request=h.event(operation);
      h.n('orderId').value='ORDERBBB12345';h.event('orderId','input');
      release(response(operation==='refresh'?completed('ORDERAAA12345'):{explanation:'OLD ORDER EXPLANATION',model:'mock'}));
      await request;
      assert.match(h.n('statusText').textContent,/Selected order changed/);
      assert.doesNotMatch(h.n('output').textContent,/OLD ORDER EXPLANATION|CAPTURE123/);
    }finally{h.restore();}
  }
});


test('confirmation checked during an uncertain-capture status recheck is revoked after APPROVED',async()=>{
  const h=setup();let getCount=0,postCount=0;let resolvePending;
  const pending=new Promise(resolve=>{resolvePending=resolve;});
  globalThis.fetch=async(url,opts)=>{
    if(opts.method==='GET'){
      getCount++;
      if(getCount===2)return pending;
      return response(approved('ORDERAAA12345'));
    }
    if(url.endsWith('/capture')){
      postCount++;
      if(postCount===1)throw Error('ambiguous capture response');
      return response(completed('ORDERAAA12345'));
    }
    throw Error('Unexpected route');
  };
  try{
    await h.load();confirm(h);await h.event('capture');
    assert.equal(postCount,1);
    const recheck=h.event('refresh');
    confirm(h); // Pre-checked before the server replied: NOT fresh consent
    assert.equal(h.n('captureConfirm').checked,true);
    resolvePending(response(approved('ORDERAAA12345')));
    await recheck;
    assert.match(h.n('statusText').textContent,/deliberate retry allowed/);
    assert.equal(h.n('captureConfirm').checked,false,'stale approval must be cleared when recheck arrives');
    assert.equal(h.n('capture').disabled,true,'capture cannot be available without renewed confirmation');
    await h.event('capture');
    assert.equal(postCount,1,'no unauthorized retry while checkbox cleared');
    confirm(h);
    await h.event('capture');
    assert.equal(postCount,2,'retry allowed after new confirmation');
  }finally{h.restore();}
});

test('A to B to A edit invalidates pending refresh, explanation, and capture preflight',async()=>{
  for(const op of ['refresh','explain','capture']){
    const h=setup();
    let resolvePending;let capturePosts=0;
    const pending=new Promise(resolve=>{resolvePending=resolve;});
    globalThis.fetch=async(url,opts)=>{
      if(url.endsWith('/capture')){capturePosts++;return response(completed('ORDERAAA12345'));}
      return pending;
    };
    try{
      await h.load();
      if(op==='capture')confirm(h);
      const old=h.event(op);
      h.n('orderId').value='ORDERBBB12345';h.event('orderId','input');
      h.n('orderId').value='ORDERAAA12345';h.event('orderId','input');
      resolvePending(response(op==='explain'
        ? {model:'stale-model',explanation:'STOLEN OLD EXPLANATION'}
        : op==='refresh'?completed('ORDERAAA12345'):approved('ORDERAAA12345')));
      await old;
      assert.match(h.n('statusText').textContent,/Selected order changed/);
      assert.doesNotMatch(h.n('output').textContent,/STOLEN OLD EXPLANATION|CAPTURE123/);
      assert.equal(h.n('captureConfirm').checked,false);
      assert.equal(capturePosts,0,'old preflight cannot trigger payment capture');
    }finally{h.restore();}
  }
});

test('explanation model label is bounded even when provider returns oversized text',async()=>{
  const h=setup(); const huge='M'.repeat(3000);
  globalThis.fetch=async()=>response({model:huge,explanation:'Bounded explanation'});
  try{
    await h.load();await h.event('explain');
    const status=h.n('statusText').textContent;
    assert.ok(status.includes('M'.repeat(256)));
    assert.ok(!status.includes('M'.repeat(257)));
    assert.ok(status.length<550);
  }finally{h.restore();}
});
