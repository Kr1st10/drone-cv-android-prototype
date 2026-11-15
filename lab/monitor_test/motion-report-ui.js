(function(){
  'use strict';
  const $=id=>document.getElementById(id),canvas=$('reportCanvas'),ctx=canvas.getContext('2d');
  let runs=[],journals=[],output=null,image=null,version=0,viewVersion=0,referenceVersion=0,selected=0,processing=false;
  let pending=[],referenceNotice='';
  const status=s=>{$('reportStatus').textContent=s;};
  const ms=x=>Number.isFinite(x)?x.toFixed(1):'нет данных';
  function invalidate(){output=null;$('reportExport').disabled=true;$('reportOutput').textContent='';}
  async function parse(file){if(!file)throw Error('Выберите файл.');return JSON.parse(await file.text());}
  async function parseJournal(file){
    if(file.size>256*1024*1024)throw Error('Журнал больше допустимых 256 МиБ.');
    const prefix=await file.slice(0,512).text();
    if(!prefix.includes('dronecv-session-timeline-'))return parse(file);
    const parser=MotionReport.timelineImporter(),reader=file.stream().getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
    let remaining='',partial=false;
    try{while(true){
      const {value,done}=await reader.read();remaining+=decoder.decode(value||new Uint8Array(),{stream:!done});let i;
      while((i=remaining.indexOf('\n'))>=0){const line=remaining.slice(0,i);remaining=remaining.slice(i+1);try{parser.push(JSON.parse(line));}catch(e){if(e instanceof SyntaxError){partial=true;break;}throw e;}}
      if(partial||done)break;if(remaining.length>16*1024*1024)throw Error('Слишком длинная строка журнала.');
    }}finally{await reader.cancel();reader.releaseLock();}
    return parser.finish(partial||!!remaining.length);
  }
  function match(j){
    const ids=new Set(j.data.frames.filter(f=>f.marker).map(f=>f.marker.run_id));
    if(!ids.size)throw Error('Sync-код не считан ни разу. Повторите запись, изменив размер или положение кода.');
    if(ids.size!==1)throw Error('В журнале несколько разных запусков. Загрузите запись одного запуска.');
    const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
    const id=[...ids][0];if(SyncCheckUI.hasId(id))throw Error('Это проверка чтения кода. Результат показан отдельно над запуском движения; эталон траектории не требуется.');const unique=new Map(runs.filter(r=>r.run_id===id).map(r=>[JSON.stringify(canonical(r)),r]));
    if(!unique.size)throw Error(`Эталон ${id} отсутствует. Загрузите файл эталона отдельно.`);
    if(unique.size>1)throw Error(`Конфликтующие эталоны с ID ${id}. Нужна однозначная запись.`);
    return [...unique.values()][0];
  }
  function pointsFor(j,run){
    if(!j.manual&&run.schema==='dronecv-motion-run-2'&&j.calibration?.points&&!j.calibration.ambiguous)j.points=j.calibration.points;
    if(j.points.length!==4)throw Error('Калибровка не выполнена. Найдите четыре метки или укажите точки на сохранённом кадре.');
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
    if(j.points.some((p,i)=>p.some(v=>!Number.isFinite(v)||v<0||v>1)||cross(p,j.points[(i+1)%4],j.points[(i+2)%4])<=1e-7))throw Error('Калибровка не выполнена: точки должны образовывать невырожденный контур TL, TR, BR, BL.');
    return MotionReport.homography(run.calibration_points,j.points);
  }
  function markerLabel(j){
    if(!j.processed)return 'Камерой не проверено: чтение сохранённого кадра.';
    if(j.image_error)return j.image_error;
    if(j.manual)return `Ручная калибровка: ${j.points.length} из 4 точек.`;
    const c=j.calibration,names=['верхняя левая','верхняя правая','нижняя правая','нижняя левая'];
    if(!c)return 'Калибровка не выполнена.';
    return c.ambiguous?'Метки распознаны неоднозначно':c.missing.length?`Не найдена ${names[c.missing[0]]} метка (${4-c.missing.length} из 4 найдены)`:'4 из 4 найдены';
  }
  function renderSelected(){
    try{renderSelectedResult();}catch(e){status('Не удалось показать результат журнала: '+e.message);}
  }
  function renderSelectedResult(){
    const j=journals[selected];
    try{SyncCheckUI.renderJournal(j||null);}catch(e){$('syncCheckStatus').textContent='Не удалось показать журнал: '+e.message;}
    if(!j){$('reportSyncStatus').textContent='Читаемость sync-кода: журнал не загружен.';$('reportTimingStatus').textContent='Временное сопоставление: журнал не загружен.';$('reportCalibrationStatus').textContent=$('motionCameraStatus').textContent='Камерой не проверено.';return;}
    try{const r=MotionJournalStatus.codeReadability(j.data);$('reportSyncStatus').textContent=`${j.name}: sync-код считан в ${r.read_frames} из ${r.total_frames} кадров; доля прочитанных кодов по всему файлу ${r.total_frames?(100*r.read_frames/r.total_frames).toFixed(1)+'%':'недостаточно данных'}; без кода ${r.missing_markers}; run_id: ${r.run_ids.join(', ')||'не обнаружены'}. ${r.recording_complete&&r.experiment_complete&&!r.truncated?'Запись и опыт завершены.':'Журнал или опыт неполный. '+(r.completeness_reason||'')}`;}catch(e){$('reportSyncStatus').textContent=`${j.name}: читаемость недоступна: ${e.message}`;}
    let run;
    try{run=match(j);const t=MotionJournalStatus.timing(run,j.data);$('reportTimingStatus').textContent=`${j.name}: сопоставлено ${t.matched_frames}, неизвестные шаги ${t.unknown_step_frames}, чужие ID ${t.foreign_run_frames}; порядок ${t.marker_order_invalid?'нарушен':'сохранён'}; без времени экспозиции ${t.untimed_frames}; зависших шагов ${t.stalled_step_ids.length}. Синхронизация: ${t.timing_status}; смещение ${ms(t.offset_lower_ms)}…${ms(t.offset_upper_ms)} мс, неопределённость ${ms(t.offset_uncertainty_ms)} мс. ${t.reason} ${t.completeness_reason?'Журнал или эталон неполный. '+t.completeness_reason:''}`;}catch(e){$('reportTimingStatus').textContent=`${j.name}: временное сопоставление недоступно: ${e.message}`;}
    const label=markerLabel(j);let spatial='Калибровка не выполнена.',estimate='';
    if(j.processed&&!j.image_error&&run){try{const project=pointsFor(j,run);spatial='Калибровка выполнена.';if(run.marker){const {x,y,module_px:m}=run.marker,a=project([x,y]),b=project([x+m,y]);const w=j.data.calibration_image.width,h=j.data.calibration_image.height;estimate=` Ячейка sync-кода: оценка через гомографию ${ms(Math.hypot((b[0]-a[0])*w,(b[1]-a[1])*h))} px.`;}}catch(e){spatial=e.message;}}
    const sizes=(j.calibration?.markers||[]).map(m=>`ID ${m.id}: ${ms(m.size_px)} px`).join(', ');
    $('reportCalibrationStatus').textContent=`${j.name}: ${label}. ${spatial}${sizes?' Размеры на кадре: '+sizes+'.':''}${estimate}`;
    const scope=j.processed&&!j.image_error?' Проверен только сохранённый кадр этого журнала; неподвижность телефона за весь прогон не подтверждается.':'';
    $('motionCameraStatus').textContent=`${j.name}: ${label}.${scope}`;
    const overall=processing?' Обработка загруженных журналов…':pending.length?' Общий отчёт ожидает: '+pending.join('; '):output?' Общий отчёт готов.':'';
    status(`${j.name}: ${label}. ${spatial}${overall}${referenceNotice?' '+referenceNotice:''}`);
  }
  function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);if(!image)return;ctx.drawImage(image,0,0);const j=journals[selected];
    for(const m of j?.calibration?.markers||[]){ctx.strokeStyle='#d00';ctx.lineWidth=3;ctx.beginPath();m.corners.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.stroke();ctx.fillStyle='#d00';ctx.font='bold 20px sans-serif';ctx.fillText(`ID ${m.id}`,m.center[0],m.center[1]);}
    j?.points.forEach(([x,y],i)=>{ctx.fillStyle='#d00';ctx.beginPath();ctx.arc(x*canvas.width,y*canvas.height,5,0,2*Math.PI);ctx.fill();ctx.font='bold 18px sans-serif';ctx.fillText(['TL','TR','BR','BL'][i],x*canvas.width+8,y*canvas.height-8);});
  }
  const percent=x=>x==null?'нет данных':(x*100).toFixed(1)+'%';
  function eventText(e){if(!e)return 'нет данных';const names={bounded:'границы',right_censored:'не подтверждено до конца наблюдения',unavailable:'нет оценки',not_applicable:'не измеряется',no_confirmed_absence:'отсутствие координат не подтверждено'};return `${names[e.status]||e.status}: ${e.lower_ms==null?'':ms(e.lower_ms)}${e.upper_ms==null?'':'…'+ms(e.upper_ms)}${e.lower_ms==null?'':' мс'}. ${e.reason||''}`;}
  function resultText(results){return results.length?'Результаты по прогонам\n'+results.map(r=>`Журнал ${r.journal}; прогон ${r.run_id}; режим телефона: ${r.mode}; ${r.criterion_version}\n`+
    `Правильная рамка: ${percent(r.good_fraction_lower)}…${percent(r.good_fraction_upper)}; покрытие: ${percent(r.coverage)}\nНеизвестно: ${ms(r.unknown_ms)} мс\n`+
    (r.criterion_version==='motion-retention-v3'?`критерий: ${r.pass===true?'пройден':r.pass===false?'не пройден':'не определён'}\n`:'')+
    `Самый длинный провал: ${ms(r.longest_failure_ms)}…${ms(r.longest_possible_failure_ms)} мс\n`+
    (r.capture?`Первый захват: ${eventText(r.capture)}\nОчистка: ${eventText(r.cleanup)}\nПовторный захват: ${eventText(r.reacquisition)}\n`:'')+
    `Sync за весь журнал: сопоставлено ${r.matched_frames}/${r.total_frames}, без кода ${r.missing_markers}, чужие/неизвестные ${r.unmatched_markers}, порядок ${r.marker_order_invalid?'нарушен':'сохранён'}, синхронизация ${r.timing_status}\n`+
    `Ошибка центра (условно на доступных рамках): p50 ${ms(r.center_error?.p50_px)}, p95 ${ms(r.center_error?.p95_px)}. Подробности и покрытие в JSON. ${r.decision_reason||''}\n`).join('\n'):'';}
  function calculate(){
    invalidate();pending=[];const items=[];
    if(!journals.length){status('Загрузите журнал телефона.');return false;}
    for(const j of journals){try{
      const run=match(j);if(!j.processed)throw Error('Калибровка ещё обрабатывается.');if(j.image_error)throw Error(j.image_error);pointsFor(j,run);
      const result=run.schema==='dronecv-motion-run-2'?MotionReportV4.analyze(run,j.data,j.points):MotionReport.analyze(run,j.data,j.points);
      items.push({run,result:{journal:j.name,calibration_points:j.points,calibration_method:j.manual?'manual':'automatic',calibration:j.calibration,scenario:run.scenario,photo:run.photo,conditions:run.conditions,...result}});
    }catch(e){pending.push(`${j.name}: ${e.message}`);}}
    const results=items.map(i=>i.result);$('reportOutput').textContent=resultText(results)+(pending.length?'\nМетрики недоступны для:\n'+pending.join('\n'):'');
    if(!pending.length){const legacyOnly=items.every(i=>i.run.schema==='dronecv-motion-run-1');output={schema:legacyOnly?'dronecv-motion-report-4':'dronecv-motion-scenario-report-1',runs:results};if(legacyOnly){output.maxima=MotionReport.maxima(items);$('reportOutput').textContent+='\n'+output.maxima.map(m=>`ограничение скорости ${m.max_speed_px_s} px/с: ${m.max_acceleration_px_s2??'не определено'} px/с²`).join('\n');}$('reportExport').disabled=false;}
    renderSelected();return !!output;
  }
  async function loadImage(j){
    const saved=j.data.calibration_image,url=saved?.data_url;
    if(typeof url!=='string'||!url.startsWith('data:image/jpeg;base64,'))throw Error('Калибровочный кадр отсутствует. Android сохраняет JPEG после первого прочитанного sync-кода. Повторите запись после изменения его размера или положения.');
    const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('Кадр не удалось декодировать.'));img.src=url;});
    if(img.naturalWidth!==saved.width||img.naturalHeight!==saved.height)throw Error('Размер кадра не совпадает с журналом.');
    return img;
  }
  async function show(token=version){
    const ticket=++viewVersion,j=journals[selected];image=null;canvas.width=canvas.height=0;renderSelected();if(!j)return;
    try{const img=await loadImage(j);if(token!==version||ticket!==viewVersion||j!==journals[selected])return;image=img;canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;draw();}
    catch(e){if(token!==version||ticket!==viewVersion||j!==journals[selected])return;j.image_error=e.message;j.processed=true;calculate();renderSelected();}
  }
  async function processAll(token){
    processing=true;
    for(const j of journals){
      if(token!==version)return;
      try{const img=await loadImage(j);if(token!==version)return;if(img.naturalWidth*img.naturalHeight>16777216)throw Error('Калибровочный кадр слишком большой.');const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const context=c.getContext('2d');context.drawImage(img,0,0);j.calibration=MotionCalibration.detect(context.getImageData(0,0,c.width,c.height));j.image_error=null;}
      catch(e){if(token!==version)return;j.image_error=e.message;}
      j.processed=true;calculate();if(j===journals[selected])await show(token);
    }
    if(token!==version)return;processing=false;calculate();await show(token);
  }
  $('reportReference').onchange=async e=>{
    const own=++referenceVersion,context=version;referenceNotice='Чтение эталона…';invalidate();renderSelected();
    try{const data=await parse(e.target.files[0]),items=data.schema==='dronecv-motion-series-1'?data.runs:[data];if(!Array.isArray(items)||items.some(r=>!['dronecv-motion-run-1','dronecv-motion-run-2'].includes(r.schema)))throw Error('Неверный эталон.');if(own!==referenceVersion)return;
      for(const r of items){await MotionStore.save(r);if(own!==referenceVersion)return;}const token=version,stored=await MotionStore.list();if(own!==referenceVersion||token!==version)return;runs=stored;referenceNotice=`Загружено эталонов: ${items.length}.`;
      if(journals.length){calculate();await show(token);}else status(referenceNotice+' Загрузите журнал телефона.');
    }catch(e){if(own===referenceVersion&&context===version){referenceNotice='Ошибка импорта эталона: '+e.message;if(journals.length){calculate();renderSelected();}else status(referenceNotice);}}
  };
  $('reportJournals').onchange=async e=>{
    const token=++version;++viewVersion;invalidate();journals=[];runs=[];selected=0;pending=[];referenceNotice='';processing=true;image=null;canvas.width=canvas.height=0;$('reportSelect').disabled=true;$('reportSelect').replaceChildren();renderSelected();status('Чтение журналов…');
    try{const loaded=await Promise.all([...e.target.files].map(async f=>{const data=await parseJournal(f);try{MotionJournalStatus.framesOf(data);}catch(e){throw Error(`${f.name}: ${e.message}`);}return {name:f.name,data,points:[],manual:false,processed:false,calibration:null,image_error:null};}));if(token!==version)return;
      journals=loaded;const select=$('reportSelect');journals.forEach((j,i)=>{const o=document.createElement('option');o.value=i;o.textContent=j.name;select.append(o);});renderSelected();
      try{const stored=await MotionStore.list();if(token!==version)return;runs=stored;}catch(e){if(token!==version)return;referenceNotice='Хранилище эталонов недоступно: '+e.message;}
      await processAll(token);}
    catch(e){if(token===version){processing=false;status(e.message);}}
    finally{if(token===version)$('reportSelect').disabled=false;}
  };
  $('reportSelect').onchange=()=>{selected=Number($('reportSelect').value);show();};
  canvas.onclick=e=>{const j=journals[selected];if(!j||!image||!j.manual||j.points.length>=4)return;const r=canvas.getBoundingClientRect();j.points.push([(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height]);draw();calculate();};
  $('reportReset').onclick=()=>{const j=journals[selected];if(j&&image){++viewVersion;j.points=[];j.manual=true;draw();calculate();}else status('Ручная калибровка доступна только при наличии настоящего кадра телефона.');};
  $('reportCalculate').onclick=calculate;
  $('reportExport').onclick=()=>{if(output)MotionGallery.download('motion-report.json',JSON.stringify(output,null,2),'application/json');};
  renderSelected();status('Камерой не проверено. Загрузите журнал телефона после запуска.');
})();
