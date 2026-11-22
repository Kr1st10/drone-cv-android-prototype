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
  async function begin(run,scenario=null,ab=null){const key=run.run_id+':'+crypto.randomUUID();return transaction(['runs','settings'],'readwrite',(t,done,guard)=>{
    const store=t.objectStore('settings'),request=store.get('localSequence');request.onsuccess=guard(()=>{
      const previous=request.result??0;if(!Number.isSafeInteger(previous)||previous<0||previous===Number.MAX_SAFE_INTEGER)throw Error('Невозможно продолжить порядок локальных запусков.');
      const sequence=previous+1;
      t.objectStore('runs').put({key,source:'local',local_sequence:sequence,run:{...run,complete:false,abort_reason:run.abort_reason||'не завершён',samples:[]}});
      store.put(sequence,'localSequence');store.put(key,'lastLocalKey');
      store.put(scenario,'last');store.put(key,'lastScenarioKey');
      if(typeof ab==='function')updateAB(store,ab,workspace=>done({key,workspace}),guard);
      else{if(ab)store.put(ab,'abSeries');done(key);}
    });
  });}
  async function append(key,index,samples,metadata=null){if(!samples.length)return;await transaction(metadata?['runs','chunks']:['chunks'],'readwrite',(t,done,guard)=>{
    t.objectStore('chunks').put({key:key+':'+index,owner:key,index,samples});
    if(metadata){const store=t.objectStore('runs'),request=store.get(key);request.onsuccess=guard(()=>{
      if(!request.result)throw Error('Начало запуска отсутствует в хранилище.');
      store.put({...request.result,run:{...metadata,samples:[]}});
    });}
  });}
  async function end(key,run,ab=null){return transaction(ab?['runs','settings']:['runs'],'readwrite',(t,done,guard)=>{
    const store=t.objectStore('runs'),request=store.get(key);request.onsuccess=guard(()=>{
      if(!request.result)throw Error('Начало запуска отсутствует в хранилище.');
      store.put({...request.result,run:{...run,samples:[]}});
      if(typeof ab==='function')updateAB(t.objectStore('settings'),ab,done,guard);
      else if(ab)t.objectStore('settings').put(ab,'abSeries');
    });
  });}
  async function list(){return (await history()).runs;}
  function canonical(value){return JSON.stringify(value,function(key,v){return v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v;});}
  const same = (a,b) => canonical(a)===canonical(b);
  const object = value => value!==null&&typeof value==='object'&&!Array.isArray(value);
  const own = (value,key) => value&&Object.hasOwn(value,key)?value[key]:undefined;
  const rowKeys={
    series: row=>row.id, attempts: row=>row.run_id, manual_observations: row=>row.run_id,
    journals: row=>row.hash, analyses: row=>canonical(row), import_issues: row=>canonical(row),
  };
  function rowKey(path){
    const key=path.at(-1);
    if(path.length===1&&key==='series')return rowKeys.series;
    if(path.length===3&&path[0]==='series'&&key!=='series'&&Object.hasOwn(rowKeys,key))return rowKeys[key];
    return null;
  }
  function mergeAB(base,local,stored,path=[],keepLocal=false){
    if(same(local,base))return stored;
    if(same(stored,base)||same(local,stored))return local;
    const identify=rowKey(path);
    if(identify&&[base,local,stored].every(value=>value===undefined||Array.isArray(value))){
      const maps=[base,local,stored].map(rows=>new Map((rows??[]).map(row=>[identify(row),row])));
      const ids=new Set([...maps[2].keys(),...maps[1].keys(),...maps[0].keys()]);
      return [...ids].map(id=>mergeAB(...maps.map(map=>map.get(id)),[...path,id],keepLocal)).filter(value=>value!==undefined);
    }
    const collection=rowKey(path.slice(0,-1))?path.at(-2):null;
    const atomic=collection==='manual_observations'||(['attempts','series'].includes(collection)&&base===undefined);
    if(!atomic&&local!==undefined&&stored!==undefined&&
        [base,local,stored].every(value=>value===undefined||object(value))){
      const keys=new Set([...Object.keys(stored),...Object.keys(local),...Object.keys(base??{})]);
      return Object.fromEntries([...keys].map(key=>[key,mergeAB(own(base,key),own(local,key),own(stored,key),[...path,key],keepLocal)])
        .filter(([,value])=>value!==undefined));
    }
    if(keepLocal)return local;
    throw Error('Конфликт изменений A/B в другой вкладке ('+path.join(' / ')+'). Исходные данные сохранены.');
  }

  function reconcileAB(target,source,path=[]){
    for(const key of Object.keys(target))if(!Object.hasOwn(source,key))delete target[key];
    for(const [key,value] of Object.entries(source)){
      const field=[...path,key], identify=rowKey(field);
      if(identify&&Array.isArray(target[key])&&Array.isArray(value)){
        const previous=new Map(target[key].map(row=>[identify(row),row]));
        target[key]=value.map(row=>{
          const id=identify(row),existing=previous.get(id);
          return existing?reconcileAB(existing,row,[...field,id]):structuredClone(row);
        });
      }else if(object(own(target,key))&&object(value))reconcileAB(target[key],value,field);
      else Object.defineProperty(target,key,{value:structuredClone(value),writable:true,enumerable:true,configurable:true});
    }
    return target;
  }

  function updateAB(store,update,done,guard){
    const request=store.get('abSeries');
    request.onsuccess=guard(()=>{
      const current=request.result??null, value=update(current);
      if(value!==undefined)store.put(value,'abSeries');
      done(value===undefined?current:value);
    });
  }
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
  async function importAB(update, series, runs) {
    return transaction(['runs','chunks','settings'],'readwrite',(t,done,guard)=>{
      const store=t.objectStore('settings'), state=store.get('abSeries');
      const rows=t.objectStore('runs').getAll(), parts=t.objectStore('chunks').getAll();
      let pending=3;
      const ready=guard(()=>{
        if(--pending)return;
        const existing=assembled(rows.result,parts.result).map(row=>row.run);
        for(const run of runs){
          const sameId=existing.filter(saved=>saved.run_id===run.run_id);
          if(sameId.some(saved=>canonical(saved)!==canonical(run)))throw Error('Конфликт эталона run_id '+run.run_id+'. Исходные данные сохранены.');
          if(sameId.length)continue;
          const key=run.run_id+':'+crypto.randomUUID();
          t.objectStore('runs').put({key,source:'import',run:{...run,samples:[]}});
          if(run.samples.length)t.objectStore('chunks').put({key:key+':0',owner:key,index:0,samples:run.samples});
        }
        const workspace=update(state.result??null);
        store.put(workspace,'abSeries');done(workspace);
      });state.onsuccess=rows.onsuccess=parts.onsuccess=ready;
    });
  }
  async function settings(value){if(arguments.length)return transaction(['settings'],'readwrite',t=>{const store=t.objectStore('settings');store.put(value,'last');store.delete('lastScenarioKey');});
    return transaction(['settings'],'readonly',(t,done)=>{const r=t.objectStore('settings').get('last');r.onsuccess=()=>done(r.result);});
  }
  /** Read or replace the A/B workspace; writes resolve only on transaction commit. */
  async function ab(value){return transaction(['settings'],arguments.length?'readwrite':'readonly',(t,done,guard)=>{
    const s=t.objectStore('settings');
    if(typeof value==='function'){updateAB(s,value,done,guard);return;}
    if(arguments.length){s.put(value,'abSeries');return;}
    const r=s.get('abSeries');r.onsuccess=()=>done(r.result??null);
  });}
  root.MotionStore={begin,append,end,list,history,save,settings,ab,importAB,mergeAB,reconcileAB};
})(globalThis);
