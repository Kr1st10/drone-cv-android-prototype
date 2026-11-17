/** Paired-trial state, comparison and portable source bundles.
 * Public API and units: AB_COMPARISON.md. State helpers mutate only the supplied
 * series; metric/comparison helpers are pure. Invalid bindings and formats throw.
 * Hashing and bundle validation are asynchronous and never write browser storage.
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();else root.MotionAB=factory();
})(globalThis,function(){
  'use strict';
  const VERSION='motion-ab-analysis-v1', FORMAT='dronecv-motion-ab-series-1';
  const clone=value=>structuredClone(value), finite=Number.isFinite;
  const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
  const known=value=>value!==null&&value!==undefined&&value!==''&&(typeof value!=='number'||finite(value));
  function compareKnown(a,b){
    if(!known(a)||!known(b))return 'unknown';
    if(typeof a==='object'&&typeof b==='object'){
      const keys=new Set([...Object.keys(a),...Object.keys(b)]),states=[...keys].map(k=>compareKnown(a[k],b[k]));
      return states.includes('different')?'different':!states.length||states.includes('unknown')?'unknown':'equal';
    }
    return canonical(a)===canonical(b)?'equal':'different';
  }
  function profile(value){
    if(typeof value==='string'&&value.trim().startsWith('{')){try{value=JSON.parse(value);}catch{throw Error('Профиль должен быть корректным JSON-объектом.');}}
    if(value&&typeof value==='object'&&!Array.isArray(value))return value;
    return null;
  }
  function create(options){
    const {factor,variants,pair_count=3,base_values={}}=options;
    if(!['mode','build','speed','acceleration'].includes(factor))throw Error('Выберите один сравниваемый фактор.');
    if(!Number.isInteger(pair_count)||pair_count<1||pair_count>10)throw Error('Число пар должно быть от 1 до 10.');
    if(!variants?.A||!variants?.B)throw Error('Нужны варианты A и B.');
    if(factor==='mode'&&['A','B'].some(s=>!['yolo','yolo_lk'].includes(variants[s].value)))throw Error('Режим телефона: yolo или yolo_lk.');
    if(factor==='build'){
      const a=profile(variants.A.value),b=profile(variants.B.value);
      if(!!a!==!!b||a&&canonical(Object.keys(a).sort())!==canonical(Object.keys(b).sort()))throw Error('Для профилей задайте одинаковые ключи в A и B.');
      const allowed=['git_sha','app_version','confidence','nms_iou','nms_max_detections','model_sha256','model_input_size','backend','intra_op_threads','inter_op_threads','execution_mode','execution_provider','lk','yolo_period_ns','confirmation_ttl_ns','retry_ns','coordinate_timeout_ns'];
      if(a&&(!Object.keys(a).length||Object.keys(a).some(k=>!allowed.includes(k))))throw Error('Профиль содержит неподдерживаемые поля.');
    }
    if(['speed','acceleration'].includes(factor)&&['A','B'].some(s=>!finite(Number(variants[s].value))||Number(variants[s].value)<=0))throw Error('Значения движения должны быть положительными числами.');
    return {schema:FORMAT,id:options.id||globalThis.crypto.randomUUID(),created_at:new Date().toISOString(),factor,
      variants:clone(variants),pair_count,base_values:clone(base_values),snapshots:{},attempts:[],selections:{},journals:[],analyses:[],
      metadata_provenance:{variant_descriptions:'operator',conditions:'operator_input',base_values:'browser_snapshot',viewport:'browser_measurement',scenario:'browser_plan',phone_fields:'journal_metadata'}};
  }
  function schedule(series){return Array.from({length:series.pair_count},(_,i)=>{
    const planned_order=i%2?'BA':'AB';return [...planned_order].map((slot,j)=>({pair_index:i+1,slot,planned_order,sequence:i*2+j+1}));
  }).flat();}
  function begin(series,details){
    if(series.attempts.some(a=>a.run_id===details.run_id))throw Error('Идентификатор запуска уже существует.');
    const item=schedule(series).find(a=>a.pair_index===details.pair_index&&a.slot===details.slot);
    if(!item)throw Error('Запуск отсутствует в плане серии.');
    const attempt={...item,...clone(details),attempt:series.attempts.filter(a=>a.pair_index===item.pair_index&&a.slot===item.slot).length+1,
      actual_order:series.attempts.length+1,complete:false,abort_reason:'не завершён'};
    series.attempts.push(attempt);return attempt;
  }
  function select(series,pair_index,slot,run_id){
    if(!series.attempts.some(a=>a.pair_index===pair_index&&a.slot===slot&&a.run_id===run_id))throw Error('Попытка не принадлежит выбранному варианту.');
    series.selections[pair_index+':'+slot]=run_id;
  }
  const missing=(reason,extra={})=>({status:'unavailable',value:null,reason,...extra});
  const exact=(value,unit,extra={})=>finite(value)?{status:'available',value,unit,...extra}:missing('Нет пригодных наблюдений.',{unit,...extra});
  const interval=(lower,upper,unit,extra={})=>finite(lower)&&finite(upper)?{status:'bounded',lower,upper,unit,...extra}:missing('Нет конечных границ.',{unit,...extra});
  function delta(A,B){
    if(!A||!B)return missing('Нет метрики одного из вариантов.');
    if(A.unit!==B.unit)return missing('Различаются единицы измерения.');
    const scale=A.unit==='fraction'?100:1,unit=A.unit==='fraction'?'pp':A.unit;
    if(A.status==='available'&&B.status==='available'&&finite(A.value)&&finite(B.value))return exact((B.value-A.value)*scale,unit);
    const bounds=m=>m.status==='available'&&finite(m.value)?[m.value,m.value]:m.status==='bounded'&&finite(m.lower)&&finite(m.upper)?[m.lower,m.upper]:null;
    const a=bounds(A),b=bounds(B);return a&&b?interval((b[0]-a[1])*scale,(b[1]-a[0])*scale,unit):missing('Разность недоступна: '+[A.reason,B.reason].filter(Boolean).join('; '),{unit});
  }
  function latencies(journal){
    const frames=new Map((journal?.frames||[]).map(f=>[f.frame_id,f])),groups={all:[],yolo:[],lk:[]};
    for(const p of journal?.publications||[]){
      const f=frames.get(p.frame_id);
      if(p.initial_snapshot||p.state_known===false||!p.bbox||!finite(f?.capture_ns)||!finite(p.published_ns)||p.published_ns<f.capture_ns)continue;
      const delay=(p.published_ns-f.capture_ns)/1e6;groups.all.push(delay);if(groups[p.source])groups[p.source].push(delay);
    }
    return Object.fromEntries(Object.entries(groups).map(([source,values])=>{
      values.sort((a,b)=>a-b);const q=p=>values.length?values[Math.max(0,Math.ceil(values.length*p)-1)]:null;
      return [source,{p50_ms:q(.5),p95_ms:q(.95),n:values.length,source,scope:'exposure_to_coordinate_publication',coverage:journal?.publications?.length?values.length/journal.publications.length:null}];
    }));
  }
  function metrics(result,journal){
    if(!result)return {};
    const r=result,m={};
    m.holding={label:'Правильное удержание за всё видимое время',...interval(r.good_fraction_lower,r.good_fraction_upper,'fraction',{coverage:r.coverage})};
    for(const [key,label,unit] of [['coverage','Покрытие оценки','fraction'],['good_ms','Правильное время','ms'],['bad_ms','Неправильное время','ms'],['unknown_ms','Неизвестное время','ms'],['good_fraction','Правильное перекрытие на оценённом времени','fraction'],['longest_failure_ms','Самый длинный подтверждённый провал','ms'],['longest_possible_failure_ms','Самый длинный возможный провал','ms']])m[key]={label,...exact(r[key],unit,{coverage:r.coverage})};
    if(!(r.expected_ms>0))for(const key of ['holding','coverage','good_ms','bad_ms','unknown_ms','good_fraction','longest_failure_ms','longest_possible_failure_ms'])m[key]={label:m[key].label,...missing('Нет видимого времени в знаменателе.',{unit:m[key].unit,coverage:null})};
    else if(!(r.evaluated_ms>0)&&!(r.evaluated_ms==null&&r.coverage>0))m.good_fraction={label:m.good_fraction.label,...missing('Нет оценённого времени; условная доля не определена.',{unit:'fraction',coverage:r.coverage})};
    for(const p of ['p50','p95'])m['center_'+p]={label:'Ошибка центра '+p,...exact(r.center_error?.[p+'_px'],'camera_px',{coverage:r.center_error?.coverage,reason:r.center_error?.unavailable_reason||'Условно на оценённом времени.'})};
    if(!(r.center_error?.evaluated_ms>0)&&!(r.center_error?.evaluated_ms==null&&r.center_error?.coverage>0))for(const p of ['p50','p95'])m['center_'+p]={label:m['center_'+p].label,...missing(r.center_error?.unavailable_reason||'Нет оценённого времени ошибки центра.',{unit:'camera_px',coverage:r.center_error?.coverage??null})};
    m.center_coverage={label:'Покрытие ошибки центра',...exact(r.center_error?.coverage,'fraction')};
    if(!((r.center_error?.expected_ms??r.expected_ms)>0))m.center_coverage={label:m.center_coverage.label,...missing('Нет времени в знаменателе ошибки центра.',{unit:'fraction'})};
    for(const [key,label] of [['capture','Первый захват'],['cleanup','Очистка'],['reacquisition','Повторный захват']]){
      const e=r[key];m[key]={label,...(e?.status==='bounded'?interval(e.lower_ms,e.upper_ms,'ms',{reason:e.reason}):missing(e?.reason||'Событие недоступно.',{status:e?.status||'unavailable',lower:e?.lower_ms??null,upper:e?.upper_ms??null,unit:'ms'}))};
    }
    for(const [source,stats] of Object.entries(latencies(journal)))for(const p of ['p50','p95'])m['latency_'+source+'_'+p]={label:'Экспозиция → публикация '+source+' '+p,...exact(stats[p+'_ms'],'ms',{n:stats.n,coverage:stats.coverage,reason:'Только согласованные timestamps одного журнала; доля пригодных публикаций.'})};
    m.sync_readability={label:'Читаемость sync-кода по всему журналу',...exact(r.total_frames>0?r.matched_frames/r.total_frames:null,'fraction',{n:r.total_frames})};
    m.recording={label:'Полнота записи',status:r.recording_complete===true?'confirmed':'unknown',value:r.recording_complete??null,reason:r.recording_complete===true?'Подтверждено журналом.':'Полнота не подтверждена.'};
    m.synchronization={label:'Синхронизация',status:r.timing_status==='compatible'?'confirmed':'unavailable',value:r.timing_status??null,reason:r.timing_status||'Неизвестно.'};
    return m;
  }
  function conditions(series,A,B,analysisA,analysisB){
    const issues=[],unknown=[],checks=[];
    const check=(label,a,b)=>{
      const state=compareKnown(a,b);checks.push({label,state,A:a??null,B:b??null});
      if(state==='unknown')unknown.push('Не подтверждено: '+label);if(state==='different')issues.push('Различается '+label);
    };
    for(const [key,label] of [['sha256','фотография (SHA-256)'],['bbox','разметка объекта'],['width','ширина фотографии'],['height','высота фотографии']])check(label,A.photo?.[key],B.photo?.[key]);
    for(const key of ['setup_id','zoom','orientation','camera_config','distance_cm','viewport'])check('установка камеры / '+key,A.conditions?.[key],B.conditions?.[key]);
    const excluded=new Set(series.factor==='speed'?['max_speed_px_s','movement_ms','disappearance_start_ms','route_time_scale']:series.factor==='acceleration'?['acceleration_px_s2','movement_ms','disappearance_start_ms','route_time_scale']:[]);
    const keys=new Set([...Object.keys(A.scenario||{}),...Object.keys(B.scenario||{})]);
    if(!keys.size)unknown.push('Не подтверждён план движения.');
    for(const key of keys)if(!excluded.has(key))check('параметр движения '+key,A.scenario?.[key],B.scenario?.[key]);
    check('период sync-кода',A.sync_period_ms,B.sync_period_ms);
    const va=A.settings_snapshot?.values,vb=B.settings_snapshot?.values;
    if(va&&vb){
      const chosen=series.factor==='speed'?'max_speed_px_s':series.factor==='acceleration'?'acceleration_px_s2':null;
      for(const key of new Set([...Object.keys(va),...Object.keys(vb)]))if(key!==chosen&&key!=='m')check('снимок настроек '+key,va[key],vb[key]);
    }
    if(['mode','build'].includes(series.factor)&&A.settings_snapshot?.plan&&B.settings_snapshot?.plan)check('сохранённый план движения',A.settings_snapshot.plan,B.settings_snapshot.plan);
    const fields=a=>a?.result?.provenance?.android?.fields||a?.provenance?.android?.fields||{};
    const af=fields(analysisA),bf=fields(analysisB);
    const profiles=series.factor==='build'?{A:profile(series.variants.A.value),B:profile(series.variants.B.value)}:null;
    const selectedFields=new Set(profiles?.A?Object.keys(profiles.A):series.factor==='build'?['git_sha']:[]);
    for(const [slot,a] of [['A',analysisA],['B',analysisB]])if(Object.keys(a?.result?.provenance?.android?.conflicts||{}).length)issues.push('Противоречивые метаданные телефона для '+slot);
    for(const [key,label] of [['model_sha256','модель'],['device','устройство'],['confidence','порог confidence'],['nms_iou','порог NMS'],['backend','backend'],['model_input_size','размер входа модели']])if(!selectedFields.has(key))check('телефон: '+label,af[key],bf[key]);
    if(!selectedFields.has('git_sha'))check('сборка приложения',af.git_sha,bf.git_sha);
    const optionalFields=['app_version','nms_max_detections','intra_op_threads','inter_op_threads','execution_mode','execution_provider','lk','yolo_period_ns','confirmation_ttl_ns','retry_ns','coordinate_timeout_ns'];
    for(const key of optionalFields)if(!selectedFields.has(key)&&!(series.factor==='mode'&&['lk','yolo_period_ns','confirmation_ttl_ns','retry_ns'].includes(key))&&(known(af[key])||known(bf[key])))check('телефон: '+key,af[key],bf[key]);
    for(const key of ['logical_id','confirmed_zoom','latest_capture_zoom'])check('камера: '+key,af.camera_context?.[key],bf.camera_context?.[key]);
    for(const key of ['requested_physical_id','latest_active_physical_id'])if(known(af.camera_context?.[key])||known(bf.camera_context?.[key]))check('камера: '+key,af.camera_context?.[key],bf.camera_context?.[key]);
    check('геометрия кадра телефона',analysisA?.result?.provenance?.geometry,analysisB?.result?.provenance?.geometry);
    if(series.factor!=='mode')check('режим приложения',analysisA?.result?.mode??af.mode,analysisB?.result?.mode??bf.mode);
    if(series.factor==='mode'||series.factor==='build')for(const [slot,a,f] of [['A',analysisA,af],['B',analysisB,bf]]){
      if(profiles?.[slot]){
        for(const [key,expected] of Object.entries(profiles[slot])){
          const state=compareKnown(expected,f[key]);if(state==='unknown')unknown.push('Профиль '+slot+': '+key+' не подтверждён журналом.');
          else if(state==='different')issues.push('В журнале другой профиль '+slot+': '+key);
        }continue;
      }
      const expected=series.variants[slot].value,actual=series.factor==='mode'?(a?.result?.mode??f.mode):f.git_sha;
      if(!known(expected)||!known(actual))unknown.push('Вариант '+slot+': значение фактора не подтверждено журналом.');
      else if(canonical(expected)!==canonical(actual))issues.push('В журнале другой '+(series.factor==='mode'?'режим приложения':'идентификатор сборки')+' для '+slot);
    }
    if(series.factor==='speed'||series.factor==='acceleration'){
      const key=series.factor==='speed'?'max_speed_px_s':'acceleration_px_s2';
      for(const [slot,r] of [['A',A],['B',B]])if(r.scenario?.[key]!==Number(series.variants[slot].value))issues.push('Значение выбранного фактора не соответствует варианту '+slot);
    }
    return {status:issues.length?'incomparable':unknown.length?'unconfirmed':'comparable',reasons:[...issues,...unknown],checks};
  }
  function selectedAnalysis(series,run_id){return (series.analyses||[]).filter(a=>a.run_id===run_id).at(-1);}
  function compare(series,pair_index,runs){
    const run_ids=Object.fromEntries(['A','B'].map(s=>[s,series.selections[pair_index+':'+s]??null]));
    const get=id=>{const found=runs.filter(r=>r.run_id===id),unique=new Map(found.map(r=>[canonical(r),r]));return unique.size===1?[...unique.values()][0]:null;};
    const A=get(run_ids.A),B=get(run_ids.B),a=selectedAnalysis(series,run_ids.A),b=selectedAnalysis(series,run_ids.B);
    const base={pair_index,run_ids,rows:[],conditions:null,reasons:[]};
    if(!A||!B)return {...base,state:'awaiting_attempt',reasons:['Выберите попытки A и B; конфликтующие ID требуют разрешения.']};
    if(A.run_id===B.run_id)return {...base,state:'incomparable',reasons:['Один прогон нельзя учитывать как независимые A и B.']};
    if(!A.complete||!B.complete)return {...base,state:'interrupted',reasons:[A,B].filter(r=>!r.complete).map(r=>'Запись прервана '+r.run_id+': '+(r.abort_reason||'причина неизвестна'))};
    const errors=['A','B'].filter(slot=>series.analysis_errors?.[run_ids[slot]]).map(slot=>slot+': '+series.analysis_errors[run_ids[slot]]);
    if(errors.length)return {...base,state:'unconfirmed',reasons:errors};
    if(!a||!b)return {...base,state:'awaiting_journal',reasons:['Ожидается журнал / анализ '+(!a?'A':'')+(!a&&!b?' и ':'')+(!b?'B':'')]};
    if(a.source_hash&&a.source_hash===b.source_hash)return {...base,state:'incomparable',reasons:['Один журнал не является двумя независимыми прогонами.']};
    const c=conditions(series,A,B,a,b),journal=x=>x.journal||(series.journals||[]).find(j=>j.hash===x.source_hash)?.data;
    const ma=metrics(a.result,journal(a)),mb=metrics(b.result,journal(b)),rows=Object.keys(ma).map(key=>({key,label:ma[key].label,unit:ma[key].unit,A:ma[key],B:mb[key],delta:c.status==='comparable'?delta(ma[key],mb[key]):missing(c.reasons.join('; '))}));
    const timing=a.result.timing_status==='compatible'&&b.result.timing_status==='compatible';
    const criterion=a.result.criterion_version===b.result.criterion_version&&['motion-scenario-v4','motion-scenario-v5'].includes(a.result.criterion_version);
    const full=(!journal(a)||journal(a).complete===true&&!journal(a).truncated)&&(!journal(b)||journal(b).complete===true&&!journal(b).truncated);
    const reasons=[...c.reasons,...(!timing?['Несовместимая или недостаточная синхронизация.']:[]),...(!criterion?['Версии критериев различаются или не поддерживают это сравнение.']:[]),...(!full?['Запись телефона неполная.']:[])];
    const state=!timing||!criterion||!full?'incomparable':c.status==='comparable'?'complete':c.status;
    if(state!=='complete')for(const row of rows)row.delta=missing(reasons.join('; '));
    return {...base,state,reasons,conditions:c,rows};
  }
  function descriptive(values){
    const s=values.filter(finite).sort((a,b)=>a-b),n=s.length;
    return {n,min:n?s[0]:null,max:n?s.at(-1):null,median:n?(s[Math.floor((n-1)/2)]+s[Math.ceil((n-1)/2)])/2:null};
  }
  function summarize(series,runs){
    const pairs=Array.from({length:series.pair_count},(_,i)=>compare(series,i+1,runs)),usable=pairs.filter(p=>p.state==='complete'),keys=new Set(usable.flatMap(p=>p.rows.map(r=>r.key))),stats={};
    for(const key of keys){const values=usable.map(p=>p.rows.find(r=>r.key===key)?.delta).filter(Boolean);
      stats[key]={exact:descriptive(values.filter(v=>v.status==='available').map(v=>v.value)),lower:descriptive(values.filter(v=>v.status==='bounded').map(v=>v.lower)),upper:descriptive(values.filter(v=>v.status==='bounded').map(v=>v.upper))};}
    return {planned:series.pair_count,performed:pairs.filter(p=>['A','B'].every(s=>series.attempts.some(a=>a.pair_index===p.pair_index&&a.slot===s&&runs.some(r=>r.run_id===a.run_id&&r.complete)))).length,
      usable:usable.length,pairs,metrics:stats,aggregation_rule:'Единица повторения: пара. Медиана, минимум и максимум парных разностей по пригодным выбранным попыткам; интервальные границы агрегируются отдельно. Медиана разностей p95 прогонов не является p95 объединённых кадров. Нет общего балла или победителя.'};
  }
  async function sha256(text){
    const bytes=new TextEncoder().encode(text),digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  }
  function sourceRunIds(data){return [...new Set((data?.frames||[]).map(f=>f.marker?.run_id).filter(known))];}
  async function registerSource(series,source){
    if(typeof source.raw!=='string'||new TextEncoder().encode(source.raw).length>256*1024*1024)throw Error('Исходный журнал отсутствует или превышает 256 МиБ.');
    const hash=await sha256(source.raw),old=series.journals.find(j=>j.hash===hash);
    if(old)return {status:'duplicate',source:old};
    const ids=sourceRunIds(source.data);
    if(ids.length!==1)throw Error(ids.length?'В журнале неоднозначные run_id.':'Журнал не содержит считанного run_id.');
    if(!series.attempts.some(a=>a.run_id===ids[0]))throw Error('Чужой run_id: '+ids[0]);
    if(series.journals.some(j=>j.run_id===ids[0]&&j.hash!==hash))throw Error('Совпадающий run_id с разным содержимым: выберите источник явно.');
    const row={...clone(source),hash,run_id:ids[0],provenance:'original_journal'};series.journals.push(row);return {status:'added',source:row};
  }
  function bind(series,run_id,hash){
    if(!series.attempts.some(a=>a.run_id===run_id))throw Error('Запуск не принадлежит серии.');
    const sources=series.journals.filter(j=>j.hash===hash);
    if(sources.length!==1||sources[0].run_id!==run_id)throw Error('Журнал не соответствует запуску.');
    const ids=sourceRunIds(sources[0].data);if(ids.length!==1||ids[0]!==run_id)throw Error('Неоднозначный run_id журнала.');
    series.bindings??={};series.bindings[run_id]=hash;
  }
  function recordAnalysis(series,run_id,analysis){
    if(series.bindings?.[run_id]!==analysis.source_hash)throw Error('Сначала привяжите исходный журнал к запуску.');
    if(!analysis.result||!analysis.parameters)throw Error('Результат анализа и параметры обязательны.');
    // Sources are retained once; each reanalysis stores parameters and a new
    // result, rather than duplicating the parsed multi-megabyte journal.
    const {journal,...entry}=analysis;
    const previous=selectedAnalysis(series,run_id),signature=a=>canonical({result:a.result,parameters:a.parameters,source_hash:a.source_hash,version:a.version});
    if(previous&&signature(previous)===signature({...entry,version:VERSION}))return previous;
    const saved={...clone(entry),run_id,version:VERSION,created_at:new Date().toISOString()};
    series.analyses.push(saved);return saved;
  }
  async function exportBundle(series,runs){
    const copy=clone(series),refs=clone(runs.filter(r=>series.attempts.some(a=>a.run_id===r.run_id))),manifest=[];
    for(const j of copy.journals){if(typeof j.raw!=='string')throw Error('Экспорт требует исходный журнал '+j.name);const hash=await sha256(j.raw);if(j.hash&&j.hash!==hash)throw Error('Изменён исходный журнал '+j.name);j.hash=hash;manifest.push({kind:'journal',id:j.run_id,sha256:hash,encoding:'utf-8',name:j.name});}
    for(const a of copy.analyses)if(!copy.journals.some(j=>j.hash===a.source_hash&&j.run_id===a.run_id))throw Error('Отсутствует исходный журнал анализа '+a.run_id);
    for(const r of refs)manifest.push({kind:'reference',id:r.run_id,sha256:await sha256(canonical(r)),encoding:'canonical-json'});
    const bundle={schema:'dronecv-motion-ab-bundle-1',analyzer_version:VERSION,criteria_versions:[...new Set(copy.analyses.map(a=>a.result?.criterion_version).filter(known))],series:copy,runs:refs,manifest,summary:summarize(copy,refs)};
    bundle.integrity=await sha256(canonical(bundle));return bundle;
  }
  async function importBundle(bundle){
    if(bundle?.schema!=='dronecv-motion-ab-bundle-1'||bundle.series?.schema!==FORMAT||!Array.isArray(bundle.runs)||!Array.isArray(bundle.manifest))throw Error('Неподдерживаемый комплект A/B.');
    const copy=clone(bundle),expected=copy.integrity;delete copy.integrity;if(!expected||await sha256(canonical(copy))!==expected)throw Error('Контрольная сумма комплекта не совпала.');
    const restored=await exportBundle(copy.series,copy.runs);
    if(canonical(restored.manifest)!==canonical(copy.manifest))throw Error('Манифест источников не совпал.');
    if(canonical(restored.summary)!==canonical(copy.summary))throw Error('Сводка не воспроизводится из сохранённых результатов и привязок.');
    const ids=new Set(copy.runs.map(r=>r.run_id));if(copy.series.attempts.some(a=>(a.state==='started'||a.complete)&&!ids.has(a.run_id)))throw Error('В комплекте отсутствует эталон начатой попытки.');
    for(const [key,id] of Object.entries(copy.series.selections)){const [pair,slot]=key.split(':');if(!copy.series.attempts.some(a=>a.pair_index===Number(pair)&&a.slot===slot&&a.run_id===id))throw Error('Повреждена привязка выбранной попытки.');}
    for(const [id,hash] of Object.entries(copy.series.bindings||{}))if(!copy.series.journals.some(j=>j.run_id===id&&j.hash===hash))throw Error('Повреждена привязка журнала.');
    return {series:clone(copy.series),runs:clone(copy.runs)};
  }
  function csv(summary,runs){
    if(runs)summary=summarize(summary,runs);
    const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"',lines=[['pair','state','run_A','run_B','metric','unit','A','B','delta','reasons']];
    for(const p of summary.pairs){if(!p.rows.length)lines.push([p.pair_index,p.state,p.run_ids.A,p.run_ids.B,'','','','','',p.reasons.join('; ')]);
      for(const row of p.rows)lines.push([p.pair_index,p.state,p.run_ids.A,p.run_ids.B,row.key,row.unit,canonical(row.A),canonical(row.B),canonical(row.delta),p.reasons.join('; ')]);}
    return lines.map(line=>line.map(quote).join(',')).join('\r\n');
  }
  return {VERSION,FORMAT,create,schedule,begin,select,canonical,compareKnown,delta,latencies,metrics,conditions,compare,summarize,sha256,sourceRunIds,registerSource,bind,recordAnalysis,exportBundle,importBundle,csv};
});
