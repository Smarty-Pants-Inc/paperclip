import { describe, it, expect } from 'vitest';
import { createNativeProviderFailureObservation } from './native-provider-failure.js';
const terminal: any = {schema:'paperclip.prp.terminal.v1',turnTerminalState:'failed',runTerminalState:'failed',reportedWorkDisposition:'blocked'};
const controls = [
  ['ordinary ToS account rejection with remediation URL', '400 invalid_request_error: Your API key was rejected because your account has not accepted the Terms of Service. See https://www.anthropic.com/legal/commercial-terms.'],
  ['ordinary ToS blocked account with remediation URL', '400 invalid_request_error: Account blocked until Terms of Service are accepted. See https://www.anthropic.com/legal/commercial-terms.'],
  ['ordinary request rate-limit restriction', '429 rate_limit_error: This request triggered rate limit restrictions.'],
] as const;
describe('independent residual ordinary-error controls',()=>{
 it.each(controls)('%s', (name,message)=>{
  const o=createNativeProviderFailureObservation({kind:'pi_rpc'});
  o.observe({schema:'paperclip.prp.event.v1',runId:'run',normalizedSessionId:'session',turnId:'turn',sourceInstanceId:'runner',sourceEventId:'event',sourceSeq:1,sourceKind:'runner',eventType:'turn.failed',schemaVersion:1,priority:0,emittedAt:new Date().toISOString(),payload:{status:'failed',error:{code:'pi_provider_error',message}}} as any);
  const result=o.forTerminal('turn',terminal);
  console.log('JUDGE_RESIDUAL_CONTROL',JSON.stringify({name,message,result}));
  expect(result).toBeNull();
 });
});
