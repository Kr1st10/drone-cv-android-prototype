(function(root){
  'use strict';
  let connection;
  function db(){return connection??=(new Promise((resolve,reject)=>{
    const request=indexedDB.open('dronecv-motion',1);
    request.onupgradeneeded=()=>{const d=request.result;d.createObjectStore('runs',{keyPath:'key'});d.createObjectStore('chunks',{keyPath:'key'});d.createObjectStore('settings');};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Закройте другую вкладку стенда для открытия хранилища.'));
  }));}
  async function transaction(stores,mode,work){const d=await db();return new Promise((resolve,reject)=>{const t=d.transaction(stores,mode);let result;try{result=work(t);}catch(e){t.abort();reject(e);return;}t.oncomplete=()=>resolve(result);t.onerror=t.onabort=()=>reject(t.error||Error('Запись в браузере не завершена.'));});}
  async function read(store){const d=await db();return new Promise((resolve,reject)=>{const r=d.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  async function begin(run){const key=run.run_id+':'+crypto.randomUUID();await transaction(['runs'],'readwrite',t=>t.objectStore('runs').put({key,run:{...run,samples:[]}}));return key;}
  async function append(key,index,samples){if(!samples.length)return;await transaction(['chunks'],'readwrite',t=>t.objectStore('chunks').put({key:key+':'+index,owner:key,index,samples}));}
  async function end(key,run){await transaction(['runs'],'readwrite',t=>t.objectStore('runs').put({key,run:{...run,samples:[]}}));}
  async function list(){const [runs,chunks]=await Promise.all([read('runs'),read('chunks')]);return runs.map(r=>({...r.run,samples:chunks.filter(c=>c.owner===r.key).sort((a,b)=>a.index-b.index).flatMap(c=>c.samples)}));}
  async function save(run){const key=await begin(run);await append(key,0,run.samples);await end(key,run);}
  async function settings(value){if(arguments.length)return transaction(['settings'],'readwrite',t=>t.objectStore('settings').put(value,'last'));const d=await db();return new Promise((resolve,reject)=>{const r=d.transaction('settings').objectStore('settings').get('last');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  root.MotionStore={begin,append,end,list,save,settings};
})(globalThis);
