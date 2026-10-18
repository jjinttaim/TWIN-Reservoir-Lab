/** Local-only import/export. All normalized timestamps mark the interval start. */
export const FIELD_DEFS = Object.freeze([
  {key:'timestamp', label:'시각', unit:'ISO 8601', required:true, aliases:['timestamp','datetime','date','time','일시','관측일시','측정일시','날짜','시간','일자']},
  {key:'inflowCms', label:'유입량', unit:'m³/s', required:true, aliases:['inflowcms','inflow','inflow_m3s','inflow_m3_s','유입량','유입유량','유입량cms','유입량m3s']},
  {key:'observedReleaseCms', label:'관측 총방류량', unit:'m³/s', required:false, aliases:['observedreleasecms','totalrelease','total_release','release','outflow','총방류량','총방류','방류량','총방류량cms']},
  {key:'observedTurbineCms', label:'관측 발전방류량', unit:'m³/s', required:false, aliases:['observedturbinecms','turbinerelease','turbine_release','generationrelease','발전방류량','발전용수량','발전사용수량']},
  {key:'observedStorageMcm', label:'관측 저수량', unit:'백만 m³', required:false, aliases:['observedstoragemcm','storage','storage_mcm','저수량','저수량백만m3','저수량mcm']},
  {key:'observedLevelM', label:'관측 저수위', unit:'m', required:false, aliases:['observedlevelm','level','waterlevel','water_level','저수위','수위','저수위elm']},
  {key:'observedGenerationMWh', label:'관측 구간 발전량', unit:'MWh', required:false, aliases:['observedgenerationmwh','generation','generation_mwh','energy','발전량','구간발전량','발전량mwh']},
  {key:'observedTurbidityNtu', label:'관측 탁도', unit:'NTU', required:false, aliases:['observedturbidityntu','turbidity','turbidity_ntu','탁도','원수탁도','방류수탁도']},
].map(field => Object.freeze({...field,aliases:Object.freeze(field.aliases)})));

const ROW_CAP = 20000;
const MISSING = new Set(['', '-', '—', 'na', 'n/a', 'null', 'nan', '결측']);
const round = (n, places=4) => Number(n.toFixed(places));

/** RFC 4180-style comma-separated input, with BOM, CRLF and quoted newlines. */
export function parseCSV(text) {
  if (typeof text !== 'string') throw new TypeError('CSV 내용은 문자열이어야 합니다.');
  if (text.length > 20 * 1024 * 1024) throw new Error('CSV 내용은 20MB 이하여야 합니다.');
  text = text.replace(/^\uFEFF/, '');
  const table = [];
  let row = [], cell = '', inQuotes = false, quotedEnded = false, cellStarted = false;
  const flushCell = () => { row.push(cell); cell=''; quotedEnded=false; cellStarted=false; };
  const flushRow = () => {
    flushCell();
    if (row.some(v => v.trim() !== '')) table.push(row);
    row=[];
    if (table.length > ROW_CAP + 1) throw new Error(`데이터는 ${ROW_CAP.toLocaleString()}행 이하로 나누어 불러오세요.`);
  };
  for (let i=0; i<text.length; i++) {
    const c=text[i];
    if (inQuotes) {
      if (c==='"') {
        if (text[i+1]==='"') { cell+='"'; i++; }
        else { inQuotes=false; quotedEnded=true; }
      } else cell+=c;
      continue;
    }
    if (c===',') { flushCell(); continue; }
    if (c==='\n' || c==='\r') { if(c==='\r' && text[i+1]==='\n') i++; flushRow(); continue; }
    if (quotedEnded) {
      if (/\s/.test(c)) continue;
      throw new Error(`닫힌 따옴표 뒤에 구분자가 없습니다 (${i+1}번째 문자).`);
    }
    if (c==='"') {
      if (cellStarted) throw new Error(`필드 중간에 따옴표가 있습니다 (${i+1}번째 문자).`);
      inQuotes=true; cellStarted=true;
    } else { cell+=c; cellStarted=true; }
  }
  if (inQuotes) throw new Error('닫히지 않은 따옴표가 있습니다. CSV 파일을 확인하세요.');
  if (cellStarted || quotedEnded || row.length || cell) flushRow();
  if (!table.length) throw new Error('CSV에 열 이름과 데이터가 없습니다.');
  const headers=table.shift().map(v => v.trim());
  if (headers.every(v=>!v)) throw new Error('CSV 첫 행에 열 이름이 필요합니다.');
  return {headers, rows:table};
}

function normalizeHeader(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s_\-\/()\[\]{}.,:\u00B7]/g,'');
}

/** Matching only known aliases prevents accidentally selecting a similar sensor. */
export function guessMapping(headers) {
  const normalized=headers.map(normalizeHeader), used=new Set(), mapping={};
  for (const field of FIELD_DEFS) {
    const candidates=[field.key,field.label,...field.aliases].map(normalizeHeader);
    const index=normalized.findIndex((h,i)=>!used.has(i) && candidates.includes(h));
    mapping[field.key]=index;
    if(index>=0) used.add(index);
  }
  return mapping;
}

function timezoneMinutes(zone) {
  if(zone==='Z' || zone==='UTC') return 0;
  const m=/^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if(!m || +m[2]>14 || +m[3]>59 || (+m[2]===14 && +m[3]!==0)) return null;
  return (m[1]==='-'?-1:1)*(+m[2]*60 + +m[3]);
}

/** Avoid Date.parse normalization of impossible calendar dates and locale ambiguity. */
function parseTimestamp(value, defaultZone) {
  if(value instanceof Date) return Number.isFinite(+value) ? +value : null;
  if(typeof value !== 'string') return null;
  const m=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if(!m) return null;
  const [,year,month,day,hour='00',minute='00',second='00',fraction='',zone]=m;
  const y=+year,mo=+month,d=+day,h=+hour,mi=+minute,s=+second;
  const leap=(y%4===0 && y%100!==0) || y%400===0;
  const maxDay=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][mo-1];
  if(y<1900 || y>2200 || mo<1 || mo>12 || d<1 || d>maxDay || h>23 || mi>59 || s>59) return null;
  const z=zone && /^[+-]\d{4}$/.test(zone) ? zone.slice(0,3)+':'+zone.slice(3) : zone;
  const offset=timezoneMinutes(z || defaultZone);
  if(offset===null) return null;
  return Date.UTC(y,mo-1,d,h,mi,s,+(fraction.padEnd(3,'0')||0)) - offset*60000;
}

function parseNumber(value) {
  if(value===null || value===undefined) return {missing:true};
  if(typeof value==='number') return Number.isFinite(value) ? {value} : {invalid:true};
  const text=String(value).trim();
  if(MISSING.has(text.toLowerCase())) return {missing:true};
  if(!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return {invalid:true};
  const number=Number(text.replaceAll(',',''));
  return Number.isFinite(number) ? {value:number} : {invalid:true};
}

function unitFactor(field, supplied) {
  const unit=String(supplied || field.unit).normalize('NFKC').toLowerCase().replace(/\s/g,'').replaceAll('³','3').replaceAll('^','');
  if(field.key.endsWith('Cms')) {
    if(['m3/s','m3/sec','cms','m3s','㎥/s'].includes(unit)) return 1;
    if(['m3/day','m3/d','m3/일','㎥/day'].includes(unit)) return 1/86400;
  } else if(field.key==='observedStorageMcm') {
    if(['mcm','백만m3','millionm3','10^6m3','106m3'].includes(unit)) return 1;
    if(['m3','㎥'].includes(unit)) return 1/1e6;
  } else if(field.key==='observedGenerationMWh') {
    if(unit==='mwh') return 1;
    if(unit==='kwh') return 1/1000;
  } else if(field.key==='observedLevelM' && unit==='m') return 1;
  else if(field.key==='observedTurbidityNtu' && unit==='ntu') return 1;
  return null;
}

/** Reject the entire import on errors: no partial rows silently enter a simulation. */
export function normalizeRows(rawRows, headers, mapping, options={}) {
  const errors=[],warnings=[], missing=Object.fromEntries(FIELD_DEFS.filter(f=>!f.required).map(f=>[f.key,0]));
  const timeZone=options.timeZone || '+09:00';
  const dataKind=['synthetic','observed','unknown'].includes(options.dataKind) ? options.dataKind : 'unknown';
  const summary={count:0,timestepHours:null,start:null,end:null,missing,dataKind,timeZone,statistics:{}};
  let totalErrors=0;
  const error=message=>{totalErrors++; if(errors.length<40)errors.push(message);};
  const finish=rows=>{
    if(totalErrors>errors.length) errors.push(`그 외 ${totalErrors-errors.length}개 오류가 있습니다.`);
    return {rows:errors.length ? [] : rows,errors,warnings,summary};
  };
  if(!Array.isArray(rawRows) || !Array.isArray(headers)) {error('열 이름과 행 배열이 필요합니다.');return finish([]);}
  if(rawRows.length>ROW_CAP) {error(`데이터는 ${ROW_CAP.toLocaleString()}행 이하로 나누어 불러오세요.`);return finish([]);}
  const provenanceColumns=headers.map((h,i)=>['sourcekind','dataorigin'].includes(normalizeHeader(h))?i:-1).filter(i=>i>=0);
  const containsSynthetic=rawRows.some(row=>Array.isArray(row)&&provenanceColumns.some(i=>String(row[i]??'').trim().toLowerCase()==='synthetic'));
  if(containsSynthetic) {
    summary.dataKind='synthetic';
    warnings.push('파일의 sourceKind 또는 dataOrigin 열에 합성자료(synthetic) 표시가 있어 합성 출처를 보존했습니다. 관측자료가 섞여 있거나 관측으로 선택했더라도 이 자료 전체는 합성자료로 분류합니다.');
  }
  if(timezoneMinutes(timeZone)===null) error('시간대는 +09:00, +00:00 또는 Z 형식이어야 합니다.');
  if(!mapping || typeof mapping!=='object') {error('열 연결 정보가 필요합니다.');return finish([]);}
  const mapped=new Map(), factors={};
  for(const field of FIELD_DEFS) {
    const i=mapping[field.key];
    if(i===-1 || i===null || i===undefined || i==='') {
      if(field.required) error(`${field.label} 열을 연결하세요.`);
      continue;
    }
    if(!Number.isInteger(i) || i<0 || i>=headers.length) {error(`${field.label}의 열 연결이 올바르지 않습니다.`);continue;}
    if(mapped.has(i)) error(`${field.label}와 ${mapped.get(i)}에 같은 열이 연결되어 있습니다.`);
    mapped.set(i,field.label);
    if(field.key!=='timestamp') {
      const factor=unitFactor(field, options.units?.[field.key]);
      if(factor===null) error(`${field.label}의 단위를 지원하지 않습니다: ${options.units?.[field.key] || field.unit}`);
      factors[field.key]=factor;
    }
  }
  if(errors.length) return finish([]);
  const rows=[],seen=new Set();
  let previous=null, unsorted=false;
  for(let index=0;index<rawRows.length;index++) {
    const raw=rawRows[index];
    if(!Array.isArray(raw)) {error(`${index+2}행: 행 형식이 올바르지 않습니다.`);continue;}
    if(raw.every(v=>v===null || v===undefined || String(v).trim()==='')) continue;
    if(raw.length>headers.length && raw.slice(headers.length).some(v=>v!==null && v!==undefined && String(v).trim()!=='')) error(`${index+2}행: 열 이름보다 값이 많습니다. 쉼표나 따옴표를 확인하세요.`);
    const timestampMs=parseTimestamp(raw[mapping.timestamp],timeZone);
    if(timestampMs===null) {error(`${index+2}행: 시각을 읽을 수 없습니다. YYYY-MM-DD HH:mm 또는 ISO 8601 형식을 사용하세요.`);continue;}
    if(seen.has(timestampMs)) error(`${index+2}행: 중복 시각 ${new Date(timestampMs).toISOString()}이 있습니다. 같은 시각의 자료를 먼저 정리하세요.`);
    seen.add(timestampMs);
    if(previous!==null && timestampMs<previous) unsorted=true;
    previous=timestampMs;
    const row={timestamp:new Date(timestampMs).toISOString()};
    for(const field of FIELD_DEFS) {
      if(field.key==='timestamp')continue;
      const column=mapping[field.key];
      const parsed=parseNumber(Number.isInteger(column)&&column>=0 ? raw[column] : null);
      if(parsed.missing) {
        row[field.key]=null;
        if(field.required) error(`${index+2}행: 필수 항목 ${field.label}이 비어 있습니다.`);
        else missing[field.key]++;
      } else if(parsed.invalid) {
        row[field.key]=null;
        error(`${index+2}행: ${field.label}은 숫자여야 합니다.`);
      } else {
        const n=parsed.value*factors[field.key];
        row[field.key]=n;
        if(!Number.isFinite(n)) error(`${index+2}행: ${field.label} 값이 너무 큽니다.`);
        else if(field.key!=='observedLevelM' && n<0) error(`${index+2}행: ${field.label}은 음수일 수 없습니다.`);
      }
    }
    if(row.observedTurbineCms!==null && row.observedReleaseCms!==null && row.observedTurbineCms>row.observedReleaseCms+1e-6)
      error(`${index+2}행: 발전방류량이 총방류량보다 큽니다. 열 연결과 단위를 확인하세요.`);
    rows.push(row);
  }
  rows.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  if(unsorted) warnings.push('시각이 시간순이 아니어서 오름차순으로 정렬했습니다.');
  summary.count=rows.length;
  if(rows.length) {summary.start=rows[0].timestamp; summary.end=rows.at(-1).timestamp;}
  if(rows.length<2) error('시간 간격을 확인하려면 유효한 데이터가 최소 2행 필요합니다.');
  else {
    const step=Date.parse(rows[1].timestamp)-Date.parse(rows[0].timestamp);
    if(step>0) {
      summary.timestepHours=step/3600000;
      let irregular=0;
      for(let i=2;i<rows.length;i++) if(Date.parse(rows[i].timestamp)-Date.parse(rows[i-1].timestamp)!==step) irregular++;
      if(irregular) error(`시간 간격이 일정하지 않은 구간이 ${irregular}개 있습니다. 누락 구간을 확인하고 같은 간격으로 정리하세요. 자동 보간하지 않습니다.`);
    }
  }
  if(summary.dataKind==='unknown')warnings.push('자료 종류가 확인되지 않았습니다. 관측자료인지 합성자료인지 지정하세요.');
  const missingLabels=FIELD_DEFS.filter(f=>!f.required&&missing[f.key]>0).map(f=>`${f.label} ${missing[f.key]}행`);
  if(missingLabels.length) warnings.push(`비어 있는 선택 항목은 0으로 채우지 않습니다: ${missingLabels.join(', ')}.`);
  if(rows.some(row=>row.observedGenerationMWh!==null)) warnings.push('발전량은 각 시각에서 시작하는 한 구간의 에너지여야 합니다. 누적 계량값이나 순간 전력(MW)은 사전에 변환하세요.');
  if(!errors.length) {
    for(const field of FIELD_DEFS) {
      if(field.key==='timestamp' || !Number.isInteger(mapping[field.key]) || mapping[field.key]<0)continue;
      const values=rows.map(row=>row[field.key]).filter(Number.isFinite);
      const count=values.length;
      summary.statistics[field.key]={label:field.label,unit:field.unit,count,missing:rows.length-count,
        min:count?Math.min(...values):null,max:count?Math.max(...values):null,
        mean:count?values.reduce((sum,value)=>sum+value/count,0):null};
    }
  }
  return finish(rows);
}

/** Safe CSV strings: spreadsheet formula-like text is prefixed with an apostrophe. */
export function toCSV(rows, fields=FIELD_DEFS.map(f=>f.key)) {
  const names=fields.map(f=>typeof f==='string'?f:f.key);
  const labels=fields.map(f=>typeof f==='string'?f:(f.label||f.key));
  const quote=value=>{
    if(value===null || value===undefined) return '';
    if(typeof value==='number') return Number.isFinite(value) ? String(value) : '';
    let text=String(value);
    if(/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text="'"+text;
    return /[",\r\n]/.test(text) ? '"'+text.replaceAll('"','""')+'"' : text;
  };
  return '\uFEFF'+[labels.map(quote).join(','),...rows.map(row=>names.map(key=>quote(row[key])).join(','))].join('\r\n')+'\r\n';
}

export function createTemplateCSV() {
  return toCSV([]);
}

/** Read with XLSX.read({cellDates:false,cellNF:true}); preserve unrounded numbers. */
export function workbookToGrids(workbook, XLSX) {
  if(!Array.isArray(workbook?.SheetNames) || !workbook.Sheets || !XLSX?.utils || !XLSX?.SSF) throw new Error('Excel 파일을 읽을 수 없습니다.');
  const grids=Object.create(null);
  const date1904=!!workbook.Workbook?.WBProps?.date1904;
  for(const name of workbook.SheetNames) {
    const sheet=workbook.Sheets[name];
    if(!sheet?.['!ref']) continue;
    const range=XLSX.utils.decode_range(sheet['!ref']);
    if(range.e.r>20050 || range.e.c>=150) throw new Error('Excel 시트가 너무 큽니다. 필요한 기간과 열만 별도 파일로 저장하세요 (20,000개 구간, 최대 150열).');
    const grid=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:true,blankrows:true});
    if(grid.length<3) continue;
    for(let r=0;r<grid.length;r++) {
      for(let c=0;c<grid[r].length;c++) {
        const cell=sheet[XLSX.utils.encode_cell({r:r+range.s.r,c:c+range.s.c})];
        if(!cell || typeof cell.v!=='number' || !cell.z || !XLSX.SSF.is_date(cell.z)) continue;
        const decoded=XLSX.SSF.parse_date_code(cell.v,{date1904});
        if(!decoded || (decoded.y===1900 && decoded.m===2 && decoded.d===29)) throw new Error(`시트 ‘${name}’의 ${r+range.s.r+1}행에 실제 달력에 없는 Excel 날짜가 있습니다.`);
        const milliseconds=Math.round(decoded.u*1000);
        const calendar=new Date(Date.UTC(decoded.y,decoded.m-1,decoded.d,decoded.H,decoded.M,decoded.S,milliseconds));
        // Excel stores a calendar date without a zone. A trailing Z would mislabel it as UTC.
        grid[r][c]=calendar.toISOString().slice(0,-1);
      }
    }
    grids[name]=grid;
  }
  return grids;
}

/** Seeded fictional event for software demonstration only, not a real dam record. */
export function createDemoData() {
  let state=724031;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const start=Date.UTC(2026,6,1)-9*3600000;
  const rows=[];
  let storage=60;
  for(let i=0;i<168;i++) {
    const pulse1=290*Math.exp(-(((i-49)/17)**2));
    const pulse2=160*Math.exp(-(((i-112)/22)**2));
    const inflow=round(50+pulse1+pulse2+random()*12,3);
    const release=round(55+0.61*pulse1+0.7*pulse2+random()*5,3);
    const turbine=round(Math.min(release,80),3);
    const level=80+(storage-10)/90*40;
    rows.push({timestamp:new Date(start+i*3600000).toISOString(),inflowCms:inflow,
      observedReleaseCms:release,observedTurbineCms:turbine,
      observedStorageMcm:round(storage,6),observedLevelM:round(level,4),
      observedGenerationMWh:round(1000*9.80665*turbine*(level-65)*0.9/1e6*(0.98+random()*0.04),4),
      observedTurbidityNtu:round(8+0.43*pulse1+0.28*pulse2+random()*3,2)});
    storage+=(inflow-release)*3600/1e6;
  }
  return {rows,meta:{dataKind:'synthetic',label:'가상 댐 합성 예제',source:'TWIN 소프트웨어 시연용 고정 난수 생성',
    warning:'실제 댐 관측자료가 아닙니다. 예제 결과는 실제 예측 정확도나 운영 개선의 증거가 아닙니다.',
    timestepHours:1,timeZone:'+09:00',count:rows.length,start:rows[0].timestamp,end:rows.at(-1).timestamp,
    timestampConvention:'interval_start',initialStorageMcm:60}};
}
