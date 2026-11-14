(function(){
  'use strict';
  const $=id=>document.getElementById(id),canvas=$('reportCanvas'),ctx=canvas.getContext('2d');
  let runs=[],journals=[],output=null,image=null,version=0,referenceVersion=0,selected=0;
  const status=s=>{$('reportStatus').textContent=s;};
  $('reportJournals').addEventListener('change',()=>{$('motionCameraStatus').textContent='Камерой не проверено для нового журнала.';},true);
  function invalidate(){output=null;$('reportExport').disabled=true;$('reportOutput').textContent='';}
  async function parse(file){if(!file)throw Error('Выберите файл.');return JSON.parse(await file.text());}
  async function parseJournal(file){
    if(file.size>256*1024*1024)throw Error('Журнал больше допустимых 256 МиБ.');
    const prefix=await file.slice(0,512).text();
    if(!prefix.includes('dronecv-session-timeline-'))return parse(file);
    const parser=MotionReport.timelineImporter(),reader=file.stream().getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
    let pending='',partial=false;
    try{while(true){
      const {value,done}=await reader.read();pending+=decoder.decode(value||new Uint8Array(),{stream:!done});let i;
      while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{parser.push(JSON.parse(line));}catch(e){if(e instanceof SyntaxError){partial=true;break;}throw e;}}
      if(partial||done)break;if(pending.length>16*1024*1024)throw Error('Слишком длинная строка журнала.');
    }}finally{await reader.cancel();reader.releaseLock();}
    return parser.finish(partial||!!pending.length);
  }
  function match(j){
    const ids=new Set(j.data.frames.filter(f=>f.marker).map(f=>f.marker.run_id));
    if(!ids.size)throw Error('Sync-код не считан ни разу. Повторите запись, изменив размер или положение кода.');
    if(ids.size!==1)throw Error('В журнале несколько разных запусков. Загрузите запись одного запуска.');
    const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
    const id=[...ids][0],unique=new Map(runs.filter(r=>r.run_id===id).map(r=>[JSON.stringify(canonical(r)),r]));
    if(!unique.size)throw Error(`Эталон ${id} отсутствует. Загрузите файл эталона отдельно.`);
    if(unique.size>1)throw Error(`Конфликтующие эталоны с ID ${id}. Нужна однозначная запись.`);
    return [...unique.values()][0];
  }
  function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);if(!image)return;ctx.drawImage(image,0,0);const j=journals[selected];
    for(const m of j?.calibration?.markers||[]){ctx.strokeStyle='#d00';ctx.lineWidth=3;ctx.beginPath();m.corners.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.stroke();ctx.fillStyle='#d00';ctx.font='bold 20px sans-serif';ctx.fillText(`ID ${m.id}`,m.center[0],m.center[1]);}
    j?.points.forEach(([x,y],i)=>{ctx.fillStyle='#d00';ctx.beginPath();ctx.arc(x*canvas.width,y*canvas.height,5,0,2*Math.PI);ctx.fill();ctx.font='bold 18px sans-serif';ctx.fillText(['TL','TR','BR','BL'][i],x*canvas.width+8,y*canvas.height-8);});
  }
  const percent=x=>x==null?'нет данных':(x*100).toFixed(1)+'%';
  function eventText(e){if(!e)return 'нет данных';const names={bounded:'границы',right_censored:'не подтверждено до конца наблюдения',unavailable:'нет оценки',not_applicable:'не измеряется',no_confirmed_absence:'отсутствие координат не подтверждено'};return `${names[e.status]||e.status}: ${e.lower_ms==null?'':e.lower_ms.toFixed(1)}${e.upper_ms==null?'':'…'+e.upper_ms.toFixed(1)}${e.lower_ms==null?'':' мс'}. ${e.reason||''}`;}
  function calculate(){invalidate();try{
    if(!journals.length)throw Error('Загрузите журнал телефона.');
    const results=journals.map(j=>{const run=match(j);if(j.points.length!==4)throw Error('Калибровка не выполнена. Найдите четыре метки или укажите точки на сохранённом кадре.');const result=run.schema==='dronecv-motion-run-2'?MotionReportV4.analyze(run,j.data,j.points):MotionReport.analyze(run,j.data,j.points);return {journal:j.name,calibration_points:j.points,calibration:j.calibration,scenario:run.scenario,photo:run.photo,conditions:run.conditions,...result};});
    const legacyOnly=journals.every(j=>match(j).schema==='dronecv-motion-run-1');
    output={schema:legacyOnly?'dronecv-motion-report-4':'dronecv-motion-scenario-report-1',runs:results};
    if(legacyOnly)output.maxima=MotionReport.maxima(journals.map((j,i)=>({run:match(j),result:results[i]})));
    $('reportExport').disabled=false;
    $('reportOutput').textContent='Результаты по прогонам\n'+results.map(r=>`Прогон ${r.run_id}; режим телефона: ${r.mode}; ${r.criterion_version}\n`+
      `Правильная рамка: ${percent(r.good_fraction_lower)}…${percent(r.good_fraction_upper)}; покрытие: ${percent(r.coverage)}\n`+
      `Неизвестно: ${r.unknown_ms.toFixed(1)} мс\n`+
      (r.criterion_version==='motion-retention-v3'?`критерий: ${r.pass===true?'пройден':r.pass===false?'не пройден':'не определён'}\n`:'')+
      `Самый длинный провал: ${r.longest_failure_ms.toFixed(1)}…${r.longest_possible_failure_ms.toFixed(1)} мс\n`+
      (r.capture?`Первый захват: ${eventText(r.capture)}\nОчистка: ${eventText(r.cleanup)}\nПовторный захват: ${eventText(r.reacquisition)}\n`:'')+
      `Sync за весь журнал: сопоставлено ${r.matched_frames}/${r.total_frames}, без кода ${r.missing_markers}, чужие/неизвестные ${r.unmatched_markers}, порядок ${r.marker_order_invalid?'нарушен':'сохранён'}, синхронизация ${r.timing_status}\n`+
      `Ошибка центра (условно на доступных рамках): p50 ${r.center_error?.conditional?.p50_px??r.center_error?.p50_px??'см. JSON'}, p95 ${r.center_error?.conditional?.p95_px??r.center_error?.p95_px??'см. JSON'}. Подробности и покрытие в JSON. ${r.decision_reason||''}\n`).join('\n');
    if(legacyOnly)$('reportOutput').textContent+='\n'+output.maxima.map(m=>`ограничение скорости ${m.max_speed_px_s} px/с: ${m.max_acceleration_px_s2??'не определено'} px/с²`).join('\n');
    return true;
  }catch(e){status(e.message);return false;}}
  async function show(token=version){const j=journals[selected];image=null;canvas.width=canvas.height=0;if(!j)return;
    let run;try{run=match(j);}catch(e){status(e.message);}
    const url=j.data.calibration_image?.data_url;
    if(typeof url!=='string'||!url.startsWith('data:image/jpeg;base64,')){status('Калибровочный кадр отсутствует. Android сохраняет JPEG после первого прочитанного sync-кода. Повторите запись после изменения его размера или положения.');return;}
    const img=new Image();try{await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('Кадр не удалось декодировать.'));img.src=url;});if(token!==version||j!==journals[selected])return;
      if(img.naturalWidth!==j.data.calibration_image.width||img.naturalHeight!==j.data.calibration_image.height)throw Error('Размер кадра не совпадает с журналом.');
      image=img;canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;ctx.drawImage(img,0,0);
      if(!j.initialized){j.points=[];j.manual=false;j.calibration=MotionCalibration.detect(ctx.getImageData(0,0,canvas.width,canvas.height));j.initialized=true;}
      const c=j.calibration;
      if(!j.manual&&run?.schema==='dronecv-motion-run-2'&&c?.points&&!c.ambiguous)j.points=c.points;
      draw();const names=['верхняя левая','верхняя правая','нижняя правая','нижняя левая'];
      const label=j.manual?'Ручная калибровка':c.ambiguous?'Метки распознаны неоднозначно':c.missing.length?`Не найдена ${names[c.missing[0]]} метка (${4-c.missing.length} из 4 найдены)`:'4 из 4 найдены';
      $('motionCameraStatus').textContent=label+'. Проверен только сохранённый кадр загруженного журнала.';
      let estimate='';
      if(run?.marker&&j.points.length===4){const project=MotionReport.homography(run.calibration_points,j.points),{x,y,module_px:m}=run.marker,a=project([x,y]),b=project([x+m,y]);estimate=` Ячейка sync-кода: оценка через гомографию ${Math.hypot((b[0]-a[0])*canvas.width,(b[1]-a[1])*canvas.height).toFixed(1)} px.`;}
      if(calculate())status(label+'. Калибровка выполнена. Размеры меток на этом кадре: '+(c?.markers||[]).map(m=>`ID ${m.id}: ${m.size_px.toFixed(1)} px`).join(', ')+estimate+'. Неподвижность телефона за весь журнал этим кадром не проверяется.');
      else{const reason=$('reportStatus').textContent;status(label+'. Калибровка не выполнена. '+reason);}
    }catch(e){if(token===version)status(e.message);}
  }
  $('reportReference').onchange=async e=>{const own=++referenceVersion,context=version;invalidate();status('Чтение эталона…');try{const data=await parse(e.target.files[0]),items=data.schema==='dronecv-motion-series-1'?data.runs:[data];if(!Array.isArray(items)||items.some(r=>!['dronecv-motion-run-1','dronecv-motion-run-2'].includes(r.schema)))throw Error('Неверный эталон.');if(own!==referenceVersion)return;
    for(const r of items){await MotionStore.save(r);if(own!==referenceVersion)return;}const token=version,stored=await MotionStore.list();if(own!==referenceVersion||token!==version)return;runs=stored;if(journals.length)await show(token);else status(`Загружено эталонов: ${items.length}. Загрузите журнал телефона.`);
  }catch(err){if(own===referenceVersion&&context===version)status(err.message);}};
  $('reportJournals').onchange=async e=>{const token=++version;invalidate();journals=[];image=null;canvas.width=canvas.height=0;$('reportSelect').disabled=true;$('reportSelect').replaceChildren();status('Чтение журналов…');try{const loaded=await Promise.all([...e.target.files].map(async f=>({name:f.name,data:await parseJournal(f),points:[]})));if(token!==version)return;if(loaded.some(j=>j.data.schema!=='dronecv-motion-android-1'||!Array.isArray(j.data.frames)))throw Error('Неверный журнал Android.');const stored=await MotionStore.list();if(token!==version)return;runs=stored;journals=loaded;selected=0;const select=$('reportSelect');journals.forEach((j,i)=>{const o=document.createElement('option');o.value=i;o.textContent=j.name;select.append(o);});await show(token);}catch(err){if(token===version)status(err.message);}finally{if(token===version)$('reportSelect').disabled=false;}};
  $('reportSelect').onchange=()=>{selected=Number($('reportSelect').value);invalidate();show(++version);};
  canvas.onclick=e=>{const j=journals[selected];if(!j||!image||!j.manual||j.points.length>=4)return;const r=canvas.getBoundingClientRect();j.points.push([(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height]);invalidate();draw();if(j.points.length===4)calculate();else status(`Указано точек: ${j.points.length} из 4.`);};
  $('reportReset').onclick=()=>{const j=journals[selected];if(j&&image){++version;j.points=[];j.manual=true;j.calibration=null;invalidate();draw();status('Укажите центры TL, TR, BR, BL на настоящем кадре.');}else status('Ручная калибровка доступна только при наличии настоящего кадра телефона.');};
  $('reportCalculate').onclick=calculate;
  $('reportExport').onclick=()=>{if(output)MotionGallery.download('motion-report.json',JSON.stringify(output,null,2),'application/json');};
  status('Камерой не проверено. Загрузите журнал телефона после запуска.');
})();
