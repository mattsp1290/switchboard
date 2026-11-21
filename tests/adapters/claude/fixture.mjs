#!/usr/bin/env node
import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync('fixture.json', 'utf8'));
writeFileSync('observed.json', JSON.stringify({ args: process.argv, env: process.env, pid: process.pid }));
if (config.mode === 'stubborn' || config.mode === 'stubborn-init' || config.mode?.endsWith('-hold')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const id = config.id ?? '12345678-1234-1234-1234-123456789abc';
function requestedModel(argv) {
  const token = argv.find(arg => arg.startsWith('--model='));
  if (token === undefined) throw new Error('fixture requires --model=');
  return token.slice('--model='.length);
}
function frameModel(field) {
  return Object.hasOwn(config, field) ? config[field] : requestedModel(process.argv);
}
let sent = false;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type !== 'control_request' || sent) continue;
  sent = true;
  send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
  send({type:'system',subtype:'init',session_id:id,model:frameModel('initModel'),apiKeySource:'ANTHROPIC_API_KEY',tools:[],mcp_servers:[]});
  if (config.mode === 'init-only' || config.mode === 'stubborn-init') continue;
  if (config.mode === 'missing') { send({type:'result',subtype:'error_during_execution',is_error:true,session_id:id}); continue; }
  if (config.mode === 'stream-rich') {
    const stream = event => send({type:'stream_event',session_id:id,parent_tool_use_id:null,event});
    const model = frameModel('streamModel');
    stream({type:'message_start',message:{id:'stream-1',model,usage:{input_tokens:3,output_tokens:1,cache_read_input_tokens:5,cache_creation_input_tokens:2}}});
    stream({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}});
    stream({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'private plan'}});
    stream({type:'content_block_stop',index:0});
    stream({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'toolu_1',name:'read_file',input:{}}});
    stream({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"path":'}});
    stream({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'"a.txt"}'}});
    stream({type:'content_block_stop',index:1});
    stream({type:'content_block_start',index:2,content_block:{type:'text',text:''}});
    stream({type:'content_block_delta',index:2,delta:{type:'text_delta',text:'pong'}});
    stream({type:'content_block_stop',index:2});
    stream({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:7}});
    stream({type:'message_stop'});
    send({type:'assistant',session_id:id,parent_tool_use_id:null,message:{id:'stream-1',model:frameModel('assistantModel'),content:[{type:'text',text:'pong'}]}});
    send({type:'result',subtype:'success',is_error:false,session_id:id,usage:{input_tokens:3,output_tokens:7,cache_read_input_tokens:5,cache_creation_input_tokens:2}});
    continue;
  }
  if (config.mode === 'stream' || config.mode === 'stream-hold' || config.mode === 'stubborn') {
    const stream = event => send({type:'stream_event',session_id:id,parent_tool_use_id:null,event});
    stream({type:'message_start',message:{id:'stream-1',model:frameModel('streamModel')}});
    if (config.mode === 'stream-hold' || config.mode === 'stubborn') continue;
    stream({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
    stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'hello'}});
    stream({type:'content_block_start',index:1,content_block:{type:'text',text:''}});
    stream({type:'content_block_delta',index:1,delta:{type:'text_delta',text:' world'}});
    send({type:'assistant',session_id:id,parent_tool_use_id:null,message:{id:'stream-1',model:frameModel('assistantModel'),content:[{type:'text',text:'hello'},{type:'text',text:' world'}]}});
    send({type:'result',subtype:'success',is_error:false,session_id:id});
    continue;
  }
  if (config.mode === 'error') {
    send({type:'assistant',session_id:id,parent_tool_use_id:null,error:'authentication_failed',message:{id:'message-1',model:frameModel('assistantModel'),content:[{type:'text',text:'secret diagnostic'}]}});
    continue;
  }
  send({type:'assistant',session_id:id,parent_tool_use_id:null,message:{id:'message-1',model:frameModel('assistantModel'),content:[{type:'text',text:'hello'}]}});
  if (config.mode === 'hold') continue;
  send({type:'assistant',session_id:id,parent_tool_use_id:null,message:{id:'message-1',model:frameModel('assistantModel'),content:[{type:'text',text:' world'}]}});
  if (config.mode !== 'writes-lost-before-hold') send({type:'result',subtype:'success',is_error:config.mode === 'result-error',session_id:id});
  if (config.mode?.startsWith('writes-lost')) send({type:'system',subtype:'session_writes_lost',session_id:id,error_code:'ENOSPC',lost:config.mode === 'writes-lost-config' ? ['global_config'] : ['transcript'],transcript_session_ids:config.mode === 'writes-lost-other' ? ['87654321-4321-4321-4321-cba987654321'] : [id],diagnostic:'secret diagnostic'});
  if (config.mode?.endsWith('-hold')) writeFileSync('loss-emitted', '');
  if (config.mode === 'post-result-system') send({type:'system',subtype:'status',status:null,session_id:id});
}
