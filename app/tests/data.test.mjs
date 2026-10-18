import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {FIELD_DEFS, parseCSV, guessMapping, normalizeRows, createDemoData, toCSV, createTemplateCSV, workbookToGrids} from '../src/data.mjs';

function load(text,options={dataKind:'observed'}) {
  const {headers,rows}=parseCSV(text);
  return normalizeRows(rows,headers,guessMapping(headers),options);
}
const minimal='timestamp,inflowCms\n2026-07-01 00:00,100\n2026-07-01 01:00,120';

test('CSV handles BOM, quoted commas, escaped quotes, CRLF and multiline fields',()=>{
  const result=parseCSV('\uFEFFtimestamp,note,value\r\n2026-07-01,"a, b\n""quoted""",0\r\n');
  assert.deepEqual(result.headers,['timestamp','note','value']);
  assert.deepEqual(result.rows,[['2026-07-01','a, b\n"quoted"','0']]);
});

test('CSV rejects unclosed quotes and trailing material after quoted fields',()=>{
  assert.throws(()=>parseCSV('time,value\n"unfinished,1'),/따옴표/);
  assert.throws(()=>parseCSV('time,value\n"2026"x,1'),/구분자/);
});

test('required aliases, Korean headers and unambiguous unit suffixes map',()=>{
  const mapping=guessMapping(['일시','유입량 (m³/s)','총방류량','발전방류량','저수량 (백만m³)','저수위','발전량 (MWh)','탁도']);
  assert.deepEqual(Object.values(mapping),[0,1,2,3,4,5,6,7]);
});

test('normalization converts Korean local timestamps and preserves optional nulls',()=>{
  const result=load(minimal);
  assert.deepEqual(result.errors,[]);
  assert.equal(result.rows[0].timestamp,'2026-06-30T15:00:00.000Z');
  assert.equal(result.rows[0].inflowCms,100);
  assert.equal(result.rows[0].observedReleaseCms,null);
  assert.equal(result.summary.missing.observedStorageMcm,2);
  assert.equal(result.summary.timestepHours,1);
  assert.equal(result.summary.dataKind,'observed');
});

test('flow, storage and energy units convert explicitly',()=>{
  const data='timestamp,inflowCms,observedStorageMcm,observedGenerationMWh\n2026-07-01T00:00:00Z,"8,640,000",60000000,4000\n2026-07-01T01:00:00Z,17280000,61000000,5000';
  const result=load(data,{dataKind:'observed',units:{inflowCms:'m³/day',observedStorageMcm:'m3',observedGenerationMWh:'kWh'}});
  assert.deepEqual(result.errors,[]);
  assert.equal(result.rows[0].inflowCms,100);
  assert.equal(result.rows[0].observedStorageMcm,60);
  assert.equal(result.rows[0].observedGenerationMWh,4);
  assert.equal(result.rows[1].inflowCms,200);
});

test('unknown units and duplicate column mapping fail closed',()=>{
  const {headers,rows}=parseCSV(minimal);
  const mapping=guessMapping(headers);
  const wrongUnit=normalizeRows(rows,headers,mapping,{units:{inflowCms:'litre/hour'}});
  assert.equal(wrongUnit.rows.length,0);
  assert.match(wrongUnit.errors.join(' '),/단위/);
  const duplicate=normalizeRows(rows,headers,{...mapping,observedReleaseCms:1});
  assert.equal(duplicate.rows.length,0);
  assert.match(duplicate.errors.join(' '),/같은 열/);
});

test('missing or non-numeric required values never become zero',()=>{
  for(const invalid of ['', 'N/A', 'error', 'NaN','Infinity','12,34']) {
    const result=load(`timestamp,inflowCms\n2026-07-01 00:00,${invalid.includes(',')?'"'+invalid+'"':invalid}\n2026-07-01 01:00,100`);
    assert.equal(result.rows.length,0,invalid);
    assert.ok(result.errors.length>0,invalid);
  }
});

test('duplicate equivalent timestamps and irregular intervals prevent simulation',()=>{
  const duplicates=load('timestamp,inflowCms\n2026-07-01 00:00,100\n2026-06-30T15:00:00Z,100');
  assert.equal(duplicates.rows.length,0);
  assert.match(duplicates.errors.join(' '),/중복/);
  const gap=load(minimal+'\n2026-07-01 03:00,150');
  assert.equal(gap.rows.length,0);
  assert.match(gap.errors.join(' '),/시간 간격/);
});

test('unsorted rows are reordered with an explicit warning',()=>{
  const result=load('timestamp,inflowCms\n2026-07-01 01:00,120\n2026-07-01 00:00,100');
  assert.deepEqual(result.errors,[]);
  assert.equal(result.rows[0].inflowCms,100);
  assert.match(result.warnings.join(' '),/정렬/);
});

test('impossible dates are rejected instead of rolling to the following month',()=>{
  for(const bad of ['2026-02-30 00:00','2026-02-29 00:00','2026-13-01 00:00','2026-07-01 24:00','2026-07-01T00:00:00+14:30']) {
    const result=load(`timestamp,inflowCms\n${bad},100\n2026-07-02 00:00,100`);
    assert.equal(result.rows.length,0,bad);
    assert.match(result.errors.join(' '),/시각/);
  }
  const leap=load('timestamp,inflowCms\n2024-02-29 00:00,1\n2024-03-01 00:00,1');
  assert.deepEqual(leap.errors,[]);
  assert.equal(leap.summary.timestepHours,24);
});

test('negative flows and turbine release exceeding total release are rejected',()=>{
  const negative=load(minimal.replace(',100',',-1'));
  assert.match(negative.errors.join(' '),/음수/);
  const inconsistent=load('timestamp,inflowCms,observedReleaseCms,observedTurbineCms\n2026-07-01 00:00,100,20,30\n2026-07-01 01:00,100,20,30');
  assert.match(inconsistent.errors.join(' '),/총방류량보다/);
});

test('single row, missing required mapping and row cap are rejected',()=>{
  assert.match(load('timestamp,inflowCms\n2026-07-01,1').errors.join(' '),/최소 2행/);
  assert.match(load('timestamp,outflow\n2026-07-01,1\n2026-07-02,2').errors.join(' '),/유입량/);
  const result=normalizeRows(Array.from({length:20001},()=>['2026-07-01',1]),['timestamp','inflowCms'],{timestamp:0,inflowCms:1});
  assert.match(result.errors.join(' '),/20,000/);
});

test('formula-like CSV strings are escaped; numerical negatives remain numeric',()=>{
  const csv=toCSV([{name:'=HYPERLINK("bad")',value:-3},{name:'  @SUM(1)',value:0},{name:'\t=evil',value:null}],['name','value']);
  const {rows}=parseCSV(csv);
  assert.equal(rows[0][0],"'=HYPERLINK(\"bad\")");
  assert.equal(rows[0][1],'-3');
  assert.equal(rows[1][0],"'  @SUM(1)");
  assert.equal(rows[2][0],"'\t=evil");
});

test('synthetic demo is reproducible, typed, regular and losslessly reimportable',()=>{
  const first=createDemoData(),second=createDemoData();
  assert.deepEqual(first,second);
  assert.equal(first.meta.dataKind,'synthetic');
  assert.equal(first.rows.length,168);
  assert.match(first.meta.warning,/실제 댐 관측자료가 아닙니다/);
  const result=load(toCSV(first.rows),{dataKind:'synthetic'});
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.rows,first.rows);
  assert.equal(result.summary.timestepHours,1);
});

test('empty template provides all canonical headers without fabricated data',()=>{
  const result=parseCSV(createTemplateCSV());
  assert.deepEqual(result.headers,FIELD_DEFS.map(field=>field.key));
  assert.deepEqual(result.rows,[]);
});

const context={};
vm.createContext(context);
vm.runInContext(readFileSync(new URL('../assets/xlsx.full.min.js',import.meta.url),'utf8'),context);
const XLSX=context.XLSX;
function workbookFromGrid(grid,{format='m/d/yy h:mm',date1904=false,infoSheet=false}={}) {
  const ws=XLSX.utils.aoa_to_sheet(grid);
  for(let i=2;i<=grid.length;i++)if(ws['A'+i])ws['A'+i].z=format;
  for(let i=2;i<=grid.length;i++)if(ws['B'+i])ws['B'+i].z='#,##0';
  const wb=XLSX.utils.book_new();
  if(infoSheet)XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['합성자료 설명']] ),'설명');
  XLSX.utils.book_append_sheet(wb,ws,'시간자료');
  if(date1904)wb.Workbook={WBProps:{date1904:true}};
  return XLSX.read(XLSX.write(wb,{type:'array',bookType:'xlsx'}),{type:'array',cellDates:false,cellNF:true});
}

test('Excel keeps full numerical precision and time hidden by display formatting',()=>{
  const wb=workbookFromGrid([['timestamp','inflowCms'],[46204,123.456789],[46204+1/24,124.987654]],{format:'m/d/yy',infoSheet:true});
  const grids=workbookToGrids(wb,XLSX);
  assert.deepEqual(Object.keys(grids),['시간자료']);
  assert.equal(grids.시간자료[1][1],123.456789);
  assert.equal(grids.시간자료[2][0],'2026-07-01T01:00:00.000');
  const q=normalizeRows(grids.시간자료.slice(1),grids.시간자료[0],guessMapping(grids.시간자료[0]),{dataKind:'synthetic',timeZone:'+09:00'});
  assert.deepEqual(q.errors,[]);
  assert.equal(q.rows[0].timestamp,'2026-06-30T15:00:00.000Z');
  assert.equal(q.summary.timestepHours,1);
});

test('Excel uses workbook date1904 system and the user-selected timezone',()=>{
  const wb=workbookFromGrid([['timestamp','inflowCms'],[46204-1462,1],[46204-1462+1/24,2]],{date1904:true,format:'yyyy"년" m"월" d"일" h:mm'});
  const grid=workbookToGrids(wb,XLSX).시간자료;
  const q=normalizeRows(grid.slice(1),grid[0],guessMapping(grid[0]),{dataKind:'synthetic',timeZone:'+00:00'});
  assert.deepEqual(q.errors,[]);
  assert.equal(q.rows[0].timestamp,'2026-07-01T00:00:00.000Z');
  assert.equal(q.summary.timestepHours,1);
});

test('Excel does not reinterpret unformatted numeric columns as dates',()=>{
  const wb=workbookFromGrid([['timestamp','inflowCms'],[46204,1],[46204+1/24,2]],{format:'General'});
  const grid=workbookToGrids(wb,XLSX).시간자료;
  assert.equal(typeof grid[1][0],'number');
  const q=normalizeRows(grid.slice(1),grid[0],guessMapping(grid[0]),{dataKind:'synthetic'});
  assert.match(q.errors.join(' '),/시각/);
});

test('Excel rejects its fictitious 1900 leap day and excessive sheet size',()=>{
  assert.throws(()=>workbookToGrids(workbookFromGrid([['timestamp','inflowCms'],[60,1],[61,2]]),XLSX),/실제 달력/);
  const wb=workbookFromGrid([['timestamp','inflowCms'],[46204,1],[46205,2]]);
  wb.Sheets.시간자료['!ref']='A1:FU3';
  assert.throws(()=>workbookToGrids(wb,XLSX),/너무 큽니다/);
});

test('explicit synthetic provenance survives an observed or unknown user choice',()=>{
  for(const header of ['sourceKind','dataOrigin'])for(const dataKind of ['observed','unknown']) {
    const text=`timestamp,inflowCms,${header}\n2026-07-01 00:00,100,observed\n2026-07-01 01:00,120, SYNTHETIC `;
    const q=load(text,{dataKind});
    assert.deepEqual(q.errors,[]);
    assert.equal(q.summary.dataKind,'synthetic');
    assert.match(q.warnings.join(' '),/합성 출처를 보존/);
    assert.equal(Object.hasOwn(q.rows[0],'sourceKind'),false);
  }
});

test('observed labels alone never upgrade unverified input into observed data',()=>{
  const text='timestamp,inflowCms,sourceKind\n2026-07-01 00:00,100,observed\n2026-07-01 01:00,120,observed';
  assert.equal(load(text,{dataKind:'unknown'}).summary.dataKind,'unknown');
  assert.equal(load(text,{dataKind:'observed'}).summary.dataKind,'observed');
  assert.equal(load(text,{dataKind:'synthetic'}).summary.dataKind,'synthetic');
});

test('column statistics use converted units and exclude missing optional values',()=>{
  const text='timestamp,inflowCms,observedStorageMcm,observedGenerationMWh\n2026-07-01 00:00,8640000,60000000,1000\n2026-07-01 01:00,17280000,,\n2026-07-01 02:00,12960000,70000000,3000';
  const q=load(text,{dataKind:'observed',units:{inflowCms:'m3/day',observedStorageMcm:'m3',observedGenerationMWh:'kWh'}});
  assert.deepEqual(q.errors,[]);
  assert.deepEqual(q.summary.statistics.inflowCms,{label:'유입량',unit:'m³/s',count:3,missing:0,min:100,max:200,mean:150});
  assert.deepEqual(q.summary.statistics.observedStorageMcm,{label:'관측 저수량',unit:'백만 m³',count:2,missing:1,min:60,max:70,mean:65});
  assert.deepEqual(q.summary.statistics.observedGenerationMWh,{label:'관측 구간 발전량',unit:'MWh',count:2,missing:1,min:1,max:3,mean:2});
  assert.equal(Object.hasOwn(q.summary.statistics,'observedReleaseCms'),false);
});

test('all-missing mapped optional column has null statistics; invalid import has none',()=>{
  const text='timestamp,inflowCms,observedTurbidityNtu\n2026-07-01 00:00,100,\n2026-07-01 01:00,200,N/A';
  const q=load(text);
  assert.deepEqual(q.errors,[]);
  assert.deepEqual(q.summary.statistics.observedTurbidityNtu,{label:'관측 탁도',unit:'NTU',count:0,missing:2,min:null,max:null,mean:null});
  const invalid=load(text.replace(',100,',',bad,'));
  assert.ok(invalid.errors.length);
  assert.deepEqual(invalid.summary.statistics,{});
});
