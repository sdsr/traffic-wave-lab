/* Traffic Wave Lab — offline interface with bundled Three.js rendering. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const keys = ['count','baselineSpeed','amplitude','period','reactionTime','timeHeadway','acceleration','comfortableBraking','desiredSpeed','minimumGap','vehicleLength','duration'];
  const units = {count:'대',baselineSpeed:' km/h',amplitude:' km/h',period:' s',reactionTime:' s',timeHeadway:' s'};
  const colors = {ink:'#242e29',muted:'#646c65',grid:'#d5dad2',green:'#285b49',rust:'#b65a3c',paper:'#f5f5ef',road:'#e6eae1'};
  let result, dataset = null, selected = 11, currentTime = 0, playing = false, lastWall = 0, timer, isFitting = false;
  let heatCache = null, chartCache = {}, roadSpan = 1000, dataName = '', appliedConfig;
  let scene3d=null, sceneFailed=false, cameraView='follow', scenePending=false;
  const fmt = (v,n=1) => Number.isFinite(v) ? v.toFixed(n) : '—';
  function readConfig() {
    const c = {...TrafficModel.defaultConfig, mode:$('mode').value, dt:.05, sampleDt:.2};
    keys.forEach(k => { const input=$(k); if (!input.checkValidity() || input.value==='') throw new Error(`${input.closest('label').textContent.trim()} 값을 확인해 주세요.`); c[k]=Number(input.value); });
    if (!dataset && c.baselineSpeed+c.amplitude>=c.desiredSpeed) throw new Error('자유 주행 희망속도를 선두차 기준 속도 + 변화 폭보다 높게 설정해 주세요.');
    return c;
  }
  function updateLabels() { keys.forEach(k => { if ($(k+'-value')) $(k+'-value').textContent = (k==='reactionTime'||k==='timeHeadway' ? Number($(k).value).toFixed(2) : $(k).value) + units[k]; }); }
  function syncDataset(c) {
    if (!dataset || Math.abs(dataset.vehicleLengthForImport-c.vehicleLength)<1e-8) return;
    const parsed=TrafficData.parseCSV(dataset.rawCSV,{vehicleLength:c.vehicleLength,sampleDt:.2});
    parsed.rawCSV=dataset.rawCSV;parsed.vehicleLengthForImport=c.vehicleLength;dataset=parsed;
  }
  function setError(text='') { $('error').hidden=!text; $('error').textContent=text; }
  function setPlaying(value) { playing=value; lastWall=0; $('play').textContent=value?'일시정지':'재생'; $('play').setAttribute('aria-label',value?'시뮬레이션 일시정지':'시뮬레이션 재생'); }
  function sampleAt(frames,t) {
    if (t<=frames[0].t) return frames[0];
    if (t>=frames[frames.length-1].t) return frames[frames.length-1];
    let l=0,r=frames.length-1; while(r-l>1) { const m=(l+r)>>1; if(frames[m].t<=t)l=m;else r=m; }
    const a=frames[l],b=frames[r],w=(t-a.t)/(b.t-a.t), f={t};
    for(const key of ['x','v','a','gap']) f[key]=a[key].map((v,i)=>v==null?null:v+(b[key][i]-v)*w);
    return f;
  }
  function carLabel(i) { return dataset ? `${i+1} · ${dataset.ids[i]}` : `${i+1}번${i===0?' · 선두':i===result.config.count-1?' · 끝차':''}`; }
  function compute() {
    if (isFitting) return;
    setPlaying(false); updateLabels();
    try {
      const c=readConfig();
      syncDataset(c);
      result=TrafficModel.run(c,dataset?.observed); appliedConfig={...result.config};
      currentTime=0; selected=Math.max(1,Math.min(selected,result.config.count-1));
      $('selected-car').replaceChildren(...Array.from({length:result.config.count-1},(_,j)=>{const o=document.createElement('option');o.value=j+1;o.textContent=carLabel(j+1);return o;}));
      $('selected-car').value=selected;
      $('timeline').max=result.frames.at(-1).t; $('timeline').value=0;
      roadSpan=Math.max(...result.frames.map(f=>f.x[0]-f.x.at(-1)),dataset?Math.max(...dataset.frames.map(f=>f.x[0]-f.x.at(-1))):0)+55;
      const ranges=result.metrics.speedRangeByCar.map(v=>v*3.6);
      result.displayRanges=ranges;
      const ratio=ranges[0]>.001?ranges.at(-1)/ranges[0]:null;
      $('amplification').innerHTML=ratio===null?'—':`${fmt(ratio,2)}<em>배</em>`;
      $('amplification-note').textContent=ratio===null?'선두차의 변동이 없어 비율 미정의':`선두 ${fmt(ranges[0])} → 끝차 ${fmt(ranges.at(-1))} km/h`;
      const minGap=result.metrics.minGap;
      $('min-gap').innerHTML=`${fmt(minGap)}<em>m</em>`;
      $('run-duration').innerHTML=`${fmt(result.frames.at(-1).t,1)}<em>s</em>`;
      $('run-status').textContent=result.collision?'충돌 검출 · 해당 시점에서 중단':'전체 계산 완료 · 충돌 미검출';
      $('condition-status').textContent=`${result.config.count}대 · 기록 ${result.frames.length.toLocaleString()}개 시점 · 조건 적용됨`;
      if(result.collision) setError(`약 ${fmt(result.collision.t,2)}초에 ${Number(result.collision.follower)+1}번 차량의 충돌이 검출되어 계산을 중단했습니다. 반응시간이나 희망 시간간격을 조절해 비교해 보세요.`); else setError();
      if(dataset) updateComparison();
      document.querySelector('.model-context').textContent=dataset?'3D 도로는 계산 차량을 표시합니다. 관측 차량은 아래 2D 대열과 점선 그래프에서 비교할 수 있습니다.':'가상 실험의 규칙적인 물결은 일정한 선두 입력과 동일한 운전자 계수에서 나온 결과입니다. 실제 도로의 움직임과 정확히 일치한다는 뜻은 아닙니다.';
      for(const el of document.querySelector('.results').children)if(el.id!=='error')el.hidden=false;
      $('export-config').disabled=false;$('export-csv').disabled=false;
      heatCache=null; chartCache={};if(scene3d){scene3d.update({frame:result.frames[0],config:result.config,selected});scene3d.resetCamera();}render();
    } catch(e) { result=null;setError(e.message);for(const el of document.querySelector('.results').children)if(el.id!=='error')el.hidden=true;$('export-config').disabled=true;$('export-csv').disabled=true;$('fit-score').textContent='비교 결과 없음';$('data-summary').textContent='입력값을 수정한 후 다시 계산해 주세요.';$('fit-progress').textContent='';$('condition-status').textContent='조건을 적용하지 못했습니다. 입력값을 수정해 주세요.'; }
  }
  function updateComparison() {
    const m=TrafficData.compare(result,dataset);
    // The public data module exposes the two aggregate follower RMSE metrics.
    const speed=m.speedRMSE ?? m.speedRmseKmh ?? m.rmseSpeedKmh;
    const gap=m.gapRMSE ?? m.gapRmseM ?? m.rmseGapM;
    $('fit-score').textContent=`뒤차 속도 RMSE ${fmt(speed,2)} km/h · 간격 RMSE ${fmt(gap,2)} m`;
    $('data-summary').textContent=`${dataset.count||dataset.ids.length}대 · 공통 구간 ${fmt(dataset.duration)} s · 비교 구간 ${fmt(result.frames.at(-1).t)} s${result.collision?' · 충돌 전 구간만 비교':''}`;
  }
  function drawScene(frame) {
    if(sceneFailed)return;
    try{
      if(!scene3d){scene3d=TrafficScene3D.create({canvas:$('road-3d'),onSelect:i=>{if(!result||i<1||i>=result.config.count)return;selected=i;$('selected-car').value=i;chartCache={};render();},onChange:()=>{if(scenePending)return;scenePending=true;requestAnimationFrame(()=>{scenePending=false;render();});}});}
      scene3d.update({frame,config:result.config,selected});
    }catch(e){sceneFailed=true;try{scene3d?.dispose();}catch(_){}scene3d=null;$('scene-fallback').hidden=false;$('scene-status').textContent='3D 표시를 사용할 수 없어 2D 대열로 표시합니다.';for(const button of document.querySelectorAll('.scene-toolbar button'))button.disabled=true;}
  }
  function changeCamera(view){cameraView=view;for(const v of ['follow','roadside','overview'])$('cam-'+v).setAttribute('aria-pressed',view===v);scene3d?.setView(view);$('scene-status').textContent=view==='follow'?'관찰 차량을 따라갑니다. 빨간 제동등은 계산상 감속을 표시합니다.':view==='roadside'?'차량이 카메라 앞을 지나갑니다. 대열이 모두 지나가면 시점 초기화로 현재 대열을 다시 볼 수 있습니다.':'대열 전체를 내려다봅니다. 차량 크기와 차간거리는 같은 미터 단위를 사용합니다.';render();}
  function setupCanvas(canvas) {
    const rect=canvas.getBoundingClientRect(),w=Math.max(1,rect.width),h=Math.max(1,rect.height),dpr=Math.min(window.devicePixelRatio||1,2);
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.font='11px "Segoe UI", "Malgun Gothic", sans-serif';ctx.lineWidth=1;return {ctx,w,h,dpr};
  }
  function text(ctx,str,x,y,color=colors.muted,align='left'){ctx.fillStyle=color;ctx.textAlign=align;ctx.fillText(str,x,y);}
  function road(f) {
    const {ctx,w,h}=setupCanvas($('road')),left=21,right=w-32,scale=(right-left)/roadSpan;
    const px=x=>right+(x-f.x[0])*scale;
    const lanes=dataset?[{f,y:53,name:'계산'},{f:sampleAt(dataset.frames,currentTime),y:115,name:'관측'}]:[{f,y:83,name:'계산'}];
    for(const lane of lanes){ctx.fillStyle=colors.road;ctx.fillRect(0,lane.y-13,w,27);ctx.strokeStyle='#ccd3c7';ctx.setLineDash([5,8]);ctx.beginPath();ctx.moveTo(0,lane.y);ctx.lineTo(w,lane.y);ctx.stroke();ctx.setLineDash([]);
      text(ctx,lane.name,0,lane.y-26);
      lane.f.x.forEach((x,i)=>{const cx=px(x),width=Math.max(Math.min(12,(w-60)/result.config.count*.55),result.config.vehicleLength*scale),color=i===0?colors.ink:i===selected?colors.green:i===lane.f.x.length-1?colors.rust:'#8b9c8e';
        ctx.fillStyle=color;ctx.strokeStyle=color;ctx.beginPath();ctx.roundRect(cx-width,lane.y-4,width,8,2);if(lane.name==='관측'){ctx.lineWidth=1.5;ctx.stroke();ctx.lineWidth=1;}else{ctx.fill();if(width>7){ctx.fillStyle=colors.road;ctx.fillRect(cx-width*.4,lane.y-2,2,4);}}
        if(i===0||i===selected||i===lane.f.x.length-1)text(ctx,i===0?'선두':i===lane.f.x.length-1?`끝차 ${i+1}`:`관찰 ${i+1}`,cx-width/2,lane.y+29,color,i===0?'right':i===lane.f.x.length-1?'left':'center');
      });
    }
    const scaleMeters=roadSpan>500?100:25,bar=scaleMeters*scale;ctx.strokeStyle=colors.muted;ctx.beginPath();ctx.moveTo(w-25-bar,h-9);ctx.lineTo(w-25,h-9);ctx.stroke();text(ctx,`${scaleMeters} m`,w-25-bar/2,h-15,colors.muted,'center');
    $('road-state').textContent=`${carLabel(selected)} · 속도 ${fmt(f.v[selected]*3.6)} km/h · 간격 ${fmt(f.gap[selected])} m`;
    $('road-scale').textContent=`표시 범위 ${fmt(roadSpan,0)} m`;
  }
  function speedColor(v,max){const u=Math.max(0,Math.min(1,v/max));const a=u<.5?[180,89,60]:[239,232,202],b=u<.5?[239,232,202]:[57,114,93],q=u<.5?u*2:(u-.5)*2;return `rgb(${a.map((x,i)=>Math.round(x+(b[i]-x)*q)).join(',')})`;}
  function drawHeatBase(){
    const o=setupCanvas($('heatmap')), {ctx,w,h,dpr}=o, p={l:43,r:8,t:12,b:34};const pw=w-p.l-p.r,ph=h-p.t-p.b,n=result.config.count,duration=result.frames.at(-1).t;
    const max=Math.ceil(Math.max(...result.frames.map(f=>Math.max(...f.v)))*3.6/10)*10||10;
    $('heat-max').textContent=max+' km/h';
    const ch=ph/n;
    for(let j=0;j<result.frames.length-1;j++)for(let i=0;i<n;i++){const x=p.l+pw*result.frames[j].t/duration,cw=pw*(result.frames[j+1].t-result.frames[j].t)/duration;ctx.fillStyle=speedColor(result.frames[j].v[i]*3.6,max);ctx.fillRect(x,p.t+i*ch,cw+.5,ch+.2);}
    const labels=[0,Math.ceil(n/3)-1,Math.ceil(2*n/3)-1,n-1];labels.forEach(i=>text(ctx,i===0?'선두':`${i+1}`,p.l-10,p.t+(i+.5)*ch+4,colors.muted,'right'));
    const ticks=w<480?3:6;for(let i=0;i<=ticks;i++)text(ctx,fmt(duration*i/ticks,0),p.l+pw*i/ticks,h-17,colors.muted,i===0?'left':i===ticks?'right':'center');text(ctx,'시간 (s)',w-p.r,h-2,colors.muted,'right');
    const buffer=document.createElement('canvas');buffer.width=$('heatmap').width;buffer.height=$('heatmap').height;buffer.getContext('2d').drawImage($('heatmap'),0,0);heatCache={buffer,w,h,dpr,p,pw,ph,duration};
  }
  function heatmap(){if(!heatCache||heatCache.w!==$('heatmap').getBoundingClientRect().width)drawHeatBase();const {ctx}=setupCanvas($('heatmap'));const c=heatCache;ctx.drawImage(c.buffer,0,0,c.w,c.h);const x=c.p.l+c.pw*currentTime/(c.duration||1);ctx.strokeStyle=colors.ink;ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(x,c.p.t);ctx.lineTo(x,c.p.t+c.ph);ctx.stroke();const y=c.p.t+(selected+.5)*c.ph/result.config.count;ctx.fillStyle=colors.green;ctx.beginPath();ctx.moveTo(c.p.l-6,y-4);ctx.lineTo(c.p.l-1,y);ctx.lineTo(c.p.l-6,y+4);ctx.fill();}
  function seriesFor(key){const n=result.config.count;const indices=key==='v'?[0,selected,n-1]:[selected,n-1];return [...new Set(indices)].map(i=>({i,color:i===0?colors.ink:i===selected?colors.green:colors.rust}));}
  function chartBase(id,key){
    const {ctx,w,h}=setupCanvas($(id)),p={l:39,r:10,t:12,b:30},pw=w-p.l-p.r,ph=h-p.t-p.b,duration=result.frames.at(-1).t,series=seriesFor(key),factor=key==='v'?3.6:1;
    const vals=[];for(const s of series)for(const f of result.frames)vals.push(f[key][s.i]*factor);
    if(dataset)for(const s of series)for(const f of dataset.frames)if(f.t<=duration)vals.push(f[key][s.i]*factor);
    let lo=Math.max(0,Math.floor(Math.min(...vals)/10)*10),hi=Math.ceil(Math.max(...vals)/10)*10;if(hi-lo<10)hi=lo+10;
    const x=t=>p.l+pw*t/(duration||1),y=v=>p.t+ph*(1-(v-lo)/(hi-lo));
    ctx.strokeStyle=colors.grid;for(let i=0;i<=4;i++){let v=lo+(hi-lo)*i/4;ctx.beginPath();ctx.moveTo(p.l,y(v));ctx.lineTo(w-p.r,y(v));ctx.stroke();text(ctx,fmt(v,Number.isInteger(v)?0:1),p.l-8,y(v)+4,colors.muted,'right');}
    const ticks=w<360?3:4;for(let i=0;i<=ticks;i++)text(ctx,fmt(duration*i/ticks,0),x(duration*i/ticks),h-13,colors.muted,i===0?'left':i===ticks?'right':'center');text(ctx,'s',w,h-13,colors.muted,'right');
    ctx.save();ctx.beginPath();ctx.rect(p.l,p.t,pw,ph);ctx.clip();
    for(const s of series){for(const observed of dataset?[true,false]:[false]){const frames=observed?dataset.frames:result.frames;ctx.strokeStyle=s.color;ctx.lineWidth=observed?1.3:1.8;ctx.globalAlpha=observed?.7:1;ctx.setLineDash(observed?[4,4]:[]);ctx.beginPath();let first=true;for(const f of frames){if(f.t>duration)break;const xx=x(f.t),yy=y(f[key][s.i]*factor);if(first){ctx.moveTo(xx,yy);first=false;}else ctx.lineTo(xx,yy);}ctx.stroke();}}
    ctx.restore();ctx.setLineDash([]);ctx.globalAlpha=1;
    const buffer=document.createElement('canvas');buffer.width=$(id).width;buffer.height=$(id).height;buffer.getContext('2d').drawImage($(id),0,0);chartCache[id]={buffer,w,h,p,pw,ph,duration,lo,hi,series,factor,key};
  }
  function chart(id,key,f){if(!chartCache[id]||chartCache[id].w!==$(id).getBoundingClientRect().width)chartBase(id,key);const {ctx}=setupCanvas($(id)),c=chartCache[id];ctx.drawImage(c.buffer,0,0,c.w,c.h);const x=c.p.l+c.pw*currentTime/(c.duration||1);ctx.strokeStyle='#8f9b8f';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,c.p.t);ctx.lineTo(x,c.p.t+c.ph);ctx.stroke();for(const s of c.series){let y=c.p.t+c.ph*(1-(f[key][s.i]*c.factor-c.lo)/(c.hi-c.lo));ctx.fillStyle=s.color;ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();}}
  function updateTable(f){if(!$('vehicle-values').closest('details').open)return;$('vehicle-values').replaceChildren(...f.v.map((v,i)=>{const row=document.createElement('tr');if(i===selected)row.className='selected';[carLabel(i),fmt(v*3.6),i===0?'—':fmt(f.gap[i]),fmt(result.displayRanges[i])].forEach(value=>{const td=document.createElement('td');td.textContent=value;row.append(td);});return row;}));}
  function render(){if(!result)return;const f=sampleAt(result.frames,currentTime);drawScene(f);road(f);heatmap();chart('speed-chart','v',f);chart('gap-chart','gap',f);$('time-label').textContent=`${fmt(currentTime)} / ${fmt(result.frames.at(-1).t,1)} s`;$('timeline').value=currentTime;$('selected-series-label').textContent=selected===result.config.count-1?'관찰 차량 · 끝차':'관찰 차량';$('tail-legend').hidden=selected===result.config.count-1;updateTable(f);}
  function tick(wall){if(playing&&result){if(lastWall){currentTime+=Math.min((wall-lastWall)/1000,.1)*Number($('playback-rate').value);if(currentTime>=result.frames.at(-1).t){currentTime=result.frames.at(-1).t;setPlaying(false);}render();}lastWall=wall;}requestAnimationFrame(tick);}
  function seek(time){currentTime=Math.max(0,Math.min(result.frames.at(-1).t,time));render();}
  function download(name,text,type){const url=URL.createObjectURL(new Blob([type.startsWith('text/csv')?'\ufeff':'',text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function setMode(measured){$('mode-simulation').setAttribute('aria-pressed',!measured);$('mode-measured').setAttribute('aria-pressed',measured);$('data-panel').hidden=!measured;}
  function acceptData(csv,name,synthetic=false){
    const parsed=TrafficData.parseCSV(csv,{vehicleLength:Number($('vehicleLength').value),sampleDt:.2});parsed.rawCSV=csv;parsed.vehicleLengthForImport=Number($('vehicleLength').value);dataset=parsed;dataName=name;
    document.body.classList.add('measured');setMode(true);$('clear-data').hidden=false;$('fit-row').hidden=false;$('observed-legend').hidden=false;
    for(const id of ['count','baselineSpeed','amplitude','period','mode'])$(id).disabled=true;
    $('source-label').textContent=synthetic?'합성 예제 · 실측 자료 아님':'사용자 CSV · 실측 비교';
    $('data-status').textContent=`${name}${synthetic?' — 기능 확인용으로 모델에서 생성한 합성 자료입니다.':''}${parsed.warnings.length?' / '+parsed.warnings.join(' / '):''}`;
    $('duration').min=1;$('duration').step='any';$('duration').value=parsed.duration;$('fit-progress').textContent='';compute();
  }
  function clearData(){dataset=null;dataName='';document.body.classList.remove('measured');for(const id of ['count','baselineSpeed','amplitude','period','mode'])$(id).disabled=false;$('clear-data').hidden=true;$('fit-row').hidden=true;$('observed-legend').hidden=true;$('source-label').textContent='가상 조건 · 실측 자료 없음';$('data-status').textContent='자료를 해제했습니다. 가상 실험 조건을 사용합니다.';$('duration').min=30;$('duration').step=10;$('duration').value=180;compute();}
  function preset(stable){if(dataset)clearData();const p={...TrafficModel.defaultConfig,count:24,baselineSpeed:65,amplitude:10,period:28,reactionTime:stable?.6:.94,timeHeadway:stable?1.8:1.35,desiredSpeed:100,duration:180};keys.forEach(k=>$(k).value=p[k]);$('mode').value='sine';$('preset-wave').setAttribute('aria-pressed',!stable);$('preset-stable').setAttribute('aria-pressed',stable);$('fit-progress').textContent='';compute();}
  keys.forEach(k=>$(k).addEventListener('input',()=>{updateLabels();$('fit-progress').textContent='';$('preset-wave').setAttribute('aria-pressed','false');$('preset-stable').setAttribute('aria-pressed','false');$('condition-status').textContent='변경한 조건을 계산 중…';clearTimeout(timer);timer=setTimeout(compute,240);}));
  $('mode').addEventListener('change',compute);$('recalculate').addEventListener('click',compute);$('preset-wave').addEventListener('click',()=>preset(false));$('preset-stable').addEventListener('click',()=>preset(true));
  $('selected-car').addEventListener('change',()=>{selected=Number($('selected-car').value);chartCache={};render();});
  for(const view of ['follow','roadside','overview'])$('cam-'+view).addEventListener('click',()=>changeCamera(view));
  $('cam-zoom-in').addEventListener('click',()=>scene3d?.setZoom(.8));$('cam-zoom-out').addEventListener('click',()=>scene3d?.setZoom(1.25));$('cam-reset').addEventListener('click',()=>{scene3d?.resetCamera();render();});
  $('scene-fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('road-section').requestFullscreen();}catch(e){$('scene-status').textContent='이 브라우저에서는 전체 화면을 사용할 수 없습니다. 확대 버튼으로 시점을 조절해 주세요.';}});
  document.addEventListener('fullscreenchange',()=>{$('scene-fullscreen').textContent=document.fullscreenElement?'원래 크기':'크게 보기';scene3d?.resize();render();});
  $('play').addEventListener('click',()=>{if(!playing&&currentTime>=result.frames.at(-1).t)seek(0);setPlaying(!playing);});$('restart').addEventListener('click',()=>{setPlaying(false);seek(0);});$('timeline').addEventListener('input',()=>seek(Number($('timeline').value)));
  ['heatmap','speed-chart','gap-chart'].forEach(id=>$(id).addEventListener('click',e=>{const c=id==='heatmap'?heatCache:chartCache[id];if(c){const x=e.clientX-$(id).getBoundingClientRect().left;seek((x-c.p.l)/c.pw*c.duration);}}));
  $('vehicle-values').closest('details').addEventListener('toggle',render);
  $('mode-measured').addEventListener('click',()=>setMode(true));$('mode-simulation').addEventListener('click',()=>{if(dataset)clearData();setMode(false);});
  $('template').addEventListener('click',()=>download('synthetic-trajectory-template.csv',TrafficData.csvTemplate(),'text/csv;charset=utf-8'));
  $('synthetic').addEventListener('click',()=>{try{const truth=TrafficModel.run({...TrafficModel.defaultConfig,count:8,duration:120,reactionTime:.6,timeHeadway:1.8,desiredSpeed:100});acceptData(TrafficData.resultToCSV(truth),'합성 예제 (생성 계수 τ=0.60 s, T=1.80 s)',true);}catch(e){setError(e.message);}});
  $('file-input').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>12*1024*1024)throw new Error('12 MB 이하의 CSV 파일을 선택해 주세요.');acceptData(await file.text(),file.name);}catch(err){setError(err.message);$('data-status').textContent=`불러오기 실패: ${err.message}`;}e.target.value='';});
  $('clear-data').addEventListener('click',clearData);
  $('export-csv').addEventListener('click',()=>{if(result)download('traffic-wave-results.csv',TrafficData.resultToCSV(result,dataset?.ids,{includeDerived:true}),'text/csv;charset=utf-8');});
  $('export-config').addEventListener('click',()=>{if(result)download('traffic-wave-config.json',JSON.stringify({app:'Traffic Wave Lab',version:'1.1',model:'IDM with explicit perception delay',dataSource:dataName||'synthetic scenario',dataSummary:dataset?.summary||null,coordinateNote:'Time and position are relative to the shared start and the leading front bumper at that time.',config:appliedConfig,metrics:result.metrics,collision:result.collision,exportedAt:new Date().toISOString()},null,2),'application/json;charset=utf-8');});
  $('calibrate').addEventListener('click',async()=>{
    if(!dataset||isFitting)return;
    setPlaying(false);setError();clearTimeout(timer);let config;try{config=readConfig();syncDataset(config);}catch(e){compute();setError(e.message);return;}isFitting=true;let fitSucceeded=false;
    const elements=[...document.querySelectorAll('input,select,button')],previous=elements.map(el=>el.disabled);elements.forEach(el=>el.disabled=true);
    try{const fit=await TrafficData.calibrate(dataset,config,{onProgress:p=>{$('fit-progress').textContent=`격자 탐색 ${p.completed} / ${p.total}`;}});const best=fit.config;if(!best)throw new Error('계수 추정 결과를 확인할 수 없습니다.');$('reactionTime').value=best.reactionTime;$('timeHeadway').value=best.timeHeadway;$('duration').value=best.duration;$('fit-progress').textContent=`추정 τ=${fmt(best.reactionTime,2)} s · T=${fmt(best.timeHeadway,2)} s · 전체 관측 구간 적합`;fitSucceeded=true;}
    catch(e){setError(e.message);$('fit-progress').textContent='추정 실패';}
    finally{isFitting=false;elements.forEach((el,i)=>el.disabled=previous[i]);if(fitSucceeded)compute();}
  });
  window.addEventListener('resize',()=>{heatCache=null;chartCache={};render();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)setPlaying(false);});
  $('reactionTime').step='.01';$('desiredSpeed').value=100;preset(false);requestAnimationFrame(tick);
})();
