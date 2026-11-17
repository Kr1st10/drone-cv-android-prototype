(function(root){
  'use strict';
  let connection;
  function db(){return connection??=(new Promise((resolve,reject)=>{
    const request=indexedDB.open('dronecv-motion',1);
    request.onupgradeneeded=()=>{const d=request.result;d.createObjectStore('runs',{keyPath:'key'});d.createObjectStore('chunks',{keyPath:'key'});d.createObjectStore('settings');};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Закройте другую вкладку стенда для открытия хранилища.'));
  }));}
  async function transaction(stores,mode,work){const d=await db();return new Promise((resolve,reject)=>{
    const t=d.transaction(stores,mode);let result,failure;
    const fail=e=>{failure=e;try{t.abort();}catch{reject(e);}};
    const guard=fn=>(...args)=>{try{fn(...args);}catch(e){fail(e);}};
    t.oncomplete=()=>resolve(result);t.onerror=t.onabort=()=>reject(failure||t.error||Error('Запись в браузере не завершена.'));
    guard(work)(t,value=>{result=value;},guard);
  });}
  function assembled(records,chunks){
    const owners=new Map();
    for(const chunk of chunks){const entries=owners.get(chunk.owner)||[];entries.push(chunk);owners.set(chunk.owner,entries);}
    return records.map(record=>({...record,run:{...record.run,samples:(owners.get(record.key)||[]).sort((a,b)=>a.index-b.index).flatMap(c=>c.samples)}}));
  }
  async function history(){return transaction(['runs','chunks','settings'],'readonly',(t,done,guard)=>{
    const store=t.objectStore('settings'),rows=t.objectStore('runs').getAll(),parts=t.objectStore('chunks').getAll(),last=store.get('lastLocalKey'),scenario=store.get('last'),scenarioKey=store.get('lastScenarioKey');let pending=5;
    const ready=guard(()=>{if(--pending)return;const records=assembled(rows.result,parts.result);
      const ordered=records.slice().sort((a,b)=>{
        const aa=Number.isSafeInteger(a.local_sequence),bb=Number.isSafeInteger(b.local_sequence);
        if(aa&&bb)return a.local_sequence-b.local_sequence;
        return aa?1:bb?-1:a.key.localeCompare(b.key);
      });
      const local=records.find(r=>r.key===last.result&&Number.isSafeInteger(r.local_sequence));
      done({runs:ordered.map(r=>r.run),last_local_run:local?.run??null,
        last_scenario:local&&scenarioKey.result===local.key?scenario.result??null:null,
        chronology_unknown:records.some(r=>!Number.isSafeInteger(r.local_sequence)&&r.source!=='import')});
    });rows.onsuccess=parts.onsuccess=last.onsuccess=scenario.onsuccess=scenarioKey.onsuccess=ready;
  });}
  async function begin(run,scenario=null){const key=run.run_id+':'+crypto.randomUUID();return transaction(['runs','settings'],'readwrite',(t,done,guard)=>{
    const store=t.objectStore('settings'),request=store.get('localSequence');request.onsuccess=guard(()=>{
      const previous=request.result??0;if(!Number.isSafeInteger(previous)||previous<0||previous===Number.MAX_SAFE_INTEGER)throw Error('Невозможно продолжить порядок локальных запусков.');
      const sequence=previous+1;
      t.objectStore('runs').put({key,source:'local',local_sequence:sequence,run:{...run,complete:false,abort_reason:run.abort_reason||'не завершён',samples:[]}});
      store.put(sequence,'localSequence');store.put(key,'lastLocalKey');
      store.put(scenario,'last');store.put(key,'lastScenarioKey');done(key);
    });
  });}
  async function append(key,index,samples,metadata=null){if(!samples.length)return;await transaction(metadata?['runs','chunks']:['chunks'],'readwrite',(t,done,guard)=>{
    t.objectStore('chunks').put({key:key+':'+index,owner:key,index,samples});
    if(metadata){const store=t.objectStore('runs'),request=store.get(key);request.onsuccess=guard(()=>{
      if(!request.result)throw Error('Начало запуска отсутствует в хранилище.');
      store.put({...request.result,run:{...metadata,samples:[]}});
    });}
  });}
  async function end(key,run){await transaction(['runs'],'readwrite',(t,done,guard)=>{
    const store=t.objectStore('runs'),request=store.get(key);request.onsuccess=guard(()=>{
      if(!request.result)throw Error('Начало запуска отсутствует в хранилище.');
      store.put({...request.result,run:{...run,samples:[]}});
    });
  });}
  async function list(){return (await history()).runs;}
  function canonical(value){return JSON.stringify(value,function(key,v){return v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v;});}
  // A completed file import commits metadata and samples together. It never
  // participates in the sequence or repeat settings of locally performed runs.
  async function save(run){
    if(!run||!Array.isArray(run.samples))throw Error('В эталоне отсутствуют фактические шаги.');
    const signature=canonical(run),key=run.run_id+':'+crypto.randomUUID();
    await transaction(['runs','chunks'],'readwrite',(t,done,guard)=>{
      const rows=t.objectStore('runs').getAll(),parts=t.objectStore('chunks').getAll();let pending=2;
      const ready=guard(()=>{if(--pending)return;
        if(assembled(rows.result,parts.result).some(r=>r.run.run_id===run.run_id&&canonical(r.run)===signature))return;
        t.objectStore('runs').put({key,source:'import',run:{...run,samples:[]}});
        if(run.samples.length)t.objectStore('chunks').put({key:key+':0',owner:key,index:0,samples:run.samples});
      });rows.onsuccess=parts.onsuccess=ready;
    });
  }
  async function settings(value){if(arguments.length)return transaction(['settings'],'readwrite',t=>{const store=t.objectStore('settings');store.put(value,'last');store.delete('lastScenarioKey');});
    return transaction(['settings'],'readonly',(t,done)=>{const r=t.objectStore('settings').get('last');r.onsuccess=()=>done(r.result);});
  }
  root.MotionStore={begin,append,end,list,history,save,settings};
})(globalThis);
