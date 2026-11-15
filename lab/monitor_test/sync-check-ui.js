(function(){
  'use strict';
  const $=id=>document.getElementById(id),key='sync_reading_checks_v1';
  let checks=MotionGallery.load(key,[]),journal=null;
  if(!Array.isArray(checks))checks=[];
  let selected=checks.at(-1)?.run_id||null;
  function render(j=journal){
    const run=checks.find(r=>r.run_id===selected);
    $('syncCheckExport').disabled=!run;
    if(!j){$('syncCheckStatus').textContent=run?`Проверка ${run.run_id}: ${run.complete?'завершена':'прервана'}, шаги ${run.steps.map(s=>s.step_id).join(', ')||'не показаны'}. Камерой не проверено. Импортируйте журнал телефона.`:'Камерой не проверено. Запустите проверку и импортируйте журнал телефона.';return;}
    const data=j.data,r=SyncCheck.analyze(run,data),integrity=data.event_integrity;
    const phase=p=>p?`${p.read} из ${p.frames} кадров в подтверждённой части интервала`:'недостаточно данных';
    const jpeg=j.processed?(j.image_error?'настоящий JPEG не подтверждён: '+j.image_error:'настоящий JPEG декодирован'):'JPEG: обработка';
    const tags=j.calibration?j.calibration.ambiguous?'неоднозначный результат':`${4-j.calibration.missing.length} из 4 найдены`:'недостаточно данных';
    $('syncCheckStatus').textContent=[
      `${j.name}. ${run?`Проверка ${run.run_id} (${run.complete?'завершена':'прервана'}).`:'Проверка не выбрана.'}`,
      `Целостность записи: ${data.truncated===true||data.recording_complete===false?'неполная / с пропусками':data.recording_complete===true?'подтверждена импортом':'недостаточно данных'}. Пропуски событий: ${integrity?`${integrity.missing_events}; dropped_count: ${integrity.dropped_count??'неизвестно'}; последовательность: ${integrity.sequence_broken?'нарушена':'без нарушений'}; footer: ${integrity.footer_present?'есть':'нет'}`:'недостаточно данных (JSON без событийной последовательности)'}.`,
      `Кадров: ${r.total}; прочитанных кодов: ${r.read}. Доля прочитанных кодов по всему файлу: ${r.fraction===null?'недостаточно данных':(100*r.fraction).toFixed(1)+'%'}.`,
      `Обнаруженные run_id: ${r.run_ids.join(', ')||'нет'}.`,
      run?`Совпало run_id и step_id: ${r.matched}; посторонний run_id: ${r.foreign}; неожиданный step_id: ${r.unknown}. Ожидаемые показанные шаги: ${run.steps.map(s=>s.step_id).join(', ')||'нет'}; прочитаны: ${r.seen.join(', ')||'нет'}; отсутствуют: ${r.missing.join(', ')||'нет'}.`:'Сопоставление run_id/step_id: недостаточно данных.',
      run&&r.matched?`Проверено камерой: прочитано ${r.seen.length} из ${run.steps.length} показанных шагов; это не подтверждает непрерывное чтение.`:r.read?'Чтение этой проверки камерой не подтверждено.':'Код не прочитан ни в одном кадре. Причина по журналу не установлена.',
      `Неизменный код: ${phase(r.static)}. При переключениях: ${phase(r.switching)}. Временное сопоставление: ${r.timing==='compatible'?'совместимо с единым смещением':r.timing==='incompatible'?'несовместимо':'недостаточно данных'}.`,
      `${jpeg}. Угловые метки: ${tags}.`
    ].join('\n');
  }
  function refresh(){const select=$('syncCheckSelect');select.replaceChildren();for(const r of checks){const o=document.createElement('option');o.value=r.run_id;o.textContent=`${r.run_id} — ${r.complete?'завершена':'прервана'}`;select.append(o);}select.value=selected||'';render();}
  function display(work){try{work();return null;}catch(e){$('syncCheckStatus').textContent='Не удалось показать результат: '+e.message;return e.message;}}
  $('syncCheckSelect').onchange=()=>{selected=$('syncCheckSelect').value;display(()=>render());};
  $('syncCheckExport').onclick=()=>{const run=checks.find(r=>r.run_id===selected);if(run)MotionGallery.download(`sync-check-${run.run_id}.json`,JSON.stringify(run,null,2),'application/json');};
  window.SyncCheckUI={hasId:id=>checks.some(r=>r.run_id===id),save(run){
    checks.push(run);selected=run.run_id;
    let saved=false;try{saved=MotionGallery.save(key,checks);}catch(_){}
    const displayError=display(refresh);
    // The in-memory record remains exportable even when persistence or analysis fails.
    $('syncCheckExport').disabled=false;
    return {saved,displayError};
  },renderJournal(j){return display(()=>{if(j)MotionJournalStatus.framesOf(j.data);render(j);journal=j;});}};
  display(refresh);
})();
