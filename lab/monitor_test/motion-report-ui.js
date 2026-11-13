(function () {
  'use strict';
  const $=id=>document.getElementById(id), canvas=$('reportCanvas'), ctx=canvas.getContext('2d');
  let runs=[], journals=[], output=null, image=null, imageRequest=0;
  const status=s=>{$('reportStatus').textContent=s;};
  function invalidate(){output=null; $('reportExport').disabled=true; $('reportOutput').textContent='';}
  async function parse(file){return JSON.parse(await file.text());}
  async function parseJournal(file) {
    // Bound memory even for a damaged file; a 30-minute session normally fits.
    if(file.size>256*1024*1024) throw Error('Журнал больше допустимых 256 МиБ.');
    const prefix=await file.slice(0,512).text();
    if(!prefix.includes('dronecv-session-timeline-')) return parse(file);
    const parser=MotionReport.timelineImporter(), reader=file.stream().getReader(), decoder=new TextDecoder('utf-8',{fatal:true});
    let pending='', partial=false;
    while(true) {
      const {value,done}=await reader.read();
      pending+=decoder.decode(value||new Uint8Array(),{stream:!done});
      let i;
      while((i=pending.indexOf('\n'))>=0) {
        const line=pending.slice(0,i);pending=pending.slice(i+1);
        try {parser.push(JSON.parse(line));} catch(err) {if(err instanceof SyntaxError){partial=true;break;}throw err;}
      }
      if(partial || done) break;
      if(pending.length>16*1024*1024) throw Error('Слишком длинная строка журнала.');
    }
    if(pending.length) partial=true;
    return parser.finish(partial);
  }
  $('reportReference').onchange=async e=>{ try { const data=await parse(e.target.files[0]); runs=data.schema==='dronecv-motion-series-1'?data.runs:[data]; if(!Array.isArray(runs)||runs.some(r=>r.schema!=='dronecv-motion-run-1')) throw Error('Неверный эталон.'); invalidate(); status(`Загружено эталонов: ${runs.length}.`); } catch(err){runs=[];invalidate();status(err.message);} };
  $('reportJournals').onchange=async e=>{ try { journals=await Promise.all([...e.target.files].map(async f=>({name:f.name,data:await parseJournal(f),points:[]}))); if(journals.some(j=>j.data.schema!=='dronecv-motion-android-1')) throw Error('Неверный журнал Android.'); const sel=$('reportSelect'); sel.replaceChildren(); journals.forEach((j,i)=>{const o=document.createElement('option');o.value=i;o.textContent=j.name;sel.append(o);}); invalidate(); await show(); } catch(err){journals=[];invalidate();status(err.message);} };
  function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);if(image)ctx.drawImage(image,0,0); const j=journals[Number($('reportSelect').value)]; j?.points.forEach(([x,y],i)=>{ctx.fillStyle='#f00';ctx.beginPath();ctx.arc(x*canvas.width,y*canvas.height,6,0,2*Math.PI);ctx.fill();ctx.font='bold 20px sans-serif';ctx.fillText(['TL','TR','BR','BL'][i],x*canvas.width+8,y*canvas.height-8);});}
  async function show(){const request=++imageRequest;const j=journals[Number($('reportSelect').value)]; image=null;canvas.width=canvas.height=0;if(!j)return; const url=j.data.calibration_image?.data_url; if(typeof url!=='string'||!url.startsWith('data:image/jpeg;base64,')){status('В журнале нет калибровочного JPEG.');return;} const img=new Image(); try {await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('Кадр не удалось декодировать.'));img.src=url;}); if(request!==imageRequest)return; if(img.naturalWidth!==j.data.calibration_image.width||img.naturalHeight!==j.data.calibration_image.height)throw Error('Размер кадра не совпадает с журналом.'); image=img;canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;draw();status(`Отмечено точек: ${j.points.length} из 4.`);}catch(err){if(request===imageRequest)status(err.message);} }
  $('reportSelect').onchange=show;
  canvas.onclick=e=>{const j=journals[Number($('reportSelect').value)];if(!j||!image||j.points.length>=4)return;const r=canvas.getBoundingClientRect();j.points.push([(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height]);invalidate();draw();status(`Отмечено точек: ${j.points.length} из 4.`);};
  $('reportReset').onclick=()=>{const j=journals[Number($('reportSelect').value)];if(j){j.points=[];invalidate();draw();status('Отметьте четыре центра.');}};
  $('reportCalculate').onclick=()=>{try {
    if(!runs.length||!journals.length) throw Error('Загрузите эталон и журналы.');
    const items=journals.map(j=>{
      if(j.points.length!==4) throw Error(`Калибровка не завершена: ${j.name}`);
      const ids=new Set(j.data.frames.filter(f=>f.marker).map(f=>f.marker.run_id));
      if(ids.size!==1) throw Error(`Ожидается один run_id: ${j.name}`);
      const candidates=runs.filter(r=>ids.has(r.run_id));
      if(candidates.length!==1) throw Error(`Эталон не найден или повторён: ${j.name}`);
      const run=candidates[0],result=MotionReport.analyze(run,j.data,j.points);
      return {run,result,journal:j.name,calibration_points:j.points};
    });
    if(new Set(items.map(i=>i.run.run_id)).size!==items.length) throw Error('Для одного run_id загружено несколько журналов.');
    output={schema:'dronecv-motion-report-4',runs:items.map(({run,result,journal,calibration_points})=>({journal,calibration_points,scenario:run.scenario,photo:run.photo,conditions:run.conditions,...result})),maxima:MotionReport.maxima(items)};
    const percent=x=>x===null?'нет данных':(x*100).toFixed(1)+'%';
    const px=x=>x===null?'нет данных':x.toFixed(2)+' px';
    const centerReasons={offset_ambiguity:'результат зависит от допустимого смещения часов',
      untrusted_interval:'неполный журнал, неизвестное состояние или разрыв наблюдений',
      outside_capture_coverage:'нет наблюдений камеры для части временной области',
      missing_frame_dimensions:'нет размеров кадра камеры',conflicting_frame_geometry:'противоречивая геометрия кадров',
      invalid_reference_geometry:'непригодная рамка эталона',incompatible:'несовместимые метки времени',
      insufficient_capture:'недостаточно меток экспозиции',no_unambiguous_coordinates:'нет однозначно сопоставленных координат'};
    const centerText=c=>`Ошибка центра (px upright crop камеры), условно по оценённому времени: средняя ${px(c.mean_px)}, p50 ${px(c.p50_px)}, p95 ${px(c.p95_px)}, наблюдавшийся максимум ${px(c.max_observed_px)}\n`+
      `Оценено ${c.evaluated_ms.toFixed(1)} из ${c.expected_ms.toFixed(1)} мс движения; покрытие ${percent(c.coverage)}; без координат ${c.absent_ms.toFixed(1)} мс; неизвестно ${c.unknown_ms.toFixed(1)} мс\n`+
      `Ограничения ошибки центра: ${Object.keys(c.unknown_reasons_ms).map(reason=>centerReasons[reason]||reason).join('; ') || centerReasons[c.unavailable_reason] || 'нет неоднозначных участков'}; отсутствие координат не имеет численной ошибки.\n`;
    $('reportOutput').textContent='Результаты по прогонам\n'+output.runs.map(r=>
      `Прогон ${r.run_id} (${r.mode}); версия критерия: ${r.criterion_version}\n`+
      centerText(r.center_error)+
      (Object.keys(r.provenance.android.conflicts).length?`Противоречивые метаданные: ${Object.keys(r.provenance.android.conflicts).join(', ')}; исходные варианты сохранены в JSON.\n`:'')+
      `Совместимый интервал смещения часов: ${r.timing_status==='compatible'?r.offset_lower_ms.toFixed(1)+'–'+r.offset_upper_ms.toFixed(1)+' мс':'не определён'}; статус: ${r.timing_status}\n`+
      `Захват (диагностика): ${r.capture_latency_ms===null?'нет':r.capture_latency_ms.toFixed(1)+' мс'}; границы доли IoU ≥ 0,5: ${percent(r.good_fraction_lower)}–${percent(r.good_fraction_upper)}; неизвестно: ${r.unknown_ms.toFixed(1)} мс; доля среди оценённых (диагностика): ${percent(r.good_fraction)}\n`+
      `Самый длинный известный провал: ${r.longest_failure_ms.toFixed(1)} мс; возможный: ${r.longest_possible_failure_ms.toFixed(1)} мс\n`+
      `Ложная рамка на пустом фоне: ${r.false_box_blank_intervals} интервалов, ${r.false_box_blank_ms.toFixed(1)} мс; несопоставленных кадров: ${r.total_frames ? ((r.missing_markers+r.unmatched_markers)*100/r.total_frames).toFixed(1) : '0'}%; покрытие: ${percent(r.coverage)}\n`+
      `Достаточно данных: ${r.sufficient?'да':'нет'}; критерий: ${r.pass===null?'не определён':r.pass?'пройден':'не пройден'}; причина: ${r.decision_reason}\n`+
      `Условия: ${JSON.stringify(r.conditions)}; фото: ${JSON.stringify(r.photo)}; сценарий: ${JSON.stringify(r.scenario)}`).join('\n\n')+
      '\n\nНаибольшее прошедшее ускорение среди испытанных уровней (минимум два разных прогона)\n'+output.maxima.map(m=>
        `${m.mode}, размер ${m.size_px} px, ограничение скорости ${m.max_speed_px_s} px/с: ${m.max_acceleration_px_s2===null?'не определено':m.max_acceleration_px_s2+' px/с²'}; фото: ${JSON.stringify(m.photo)}; окно: ${m.viewport.width}×${m.viewport.height}; кругов: ${m.laps}; условия: ${JSON.stringify(m.conditions)}; run_id: ${m.run_ids.join(', ') || 'нет'}; критерий: ${m.criterion_version}`).join('\n');
    $('reportExport').disabled=false;status('Отчёт рассчитан. null означает неопределённый результат или отсутствие прошедшего уровня.');
  }catch(err){invalidate();status(err.message);}};
  $('reportExport').onclick=()=>{if(output)MotionGallery.download('motion-report.json',JSON.stringify(output,null,2),'application/json');};
})();
