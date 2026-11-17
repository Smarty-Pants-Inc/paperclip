import { describe, it, expect } from 'vitest';
import { createNativeProviderFailureObservation } from './native-provider-failure.js';
const terminal: any = { schema:'paperclip.prp.terminal.v1',turnTerminalState:'failed',runTerminalState:'failed',reportedWorkDisposition:'blocked' };
const live1 = "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.";
const live2 = "blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs";
function classify(message:string, answer = false) {
 const o=createNativeProviderFailureObservation({kind:'pi_rpc'});
 o.observe({schema:'paperclip.prp.event.v1',runId:'run',normalizedSessionId:'session',turnId:'turn',sourceInstanceId:'runner',sourceEventId:'event',sourceSeq:1,sourceKind:'runner',eventType:answer?'item.completed':'turn.failed',schemaVersion:1,priority:0,emittedAt:new Date().toISOString(),payload:answer?{kind:'agentMessage',channel:'final',text:message}:{status:'failed',error:{code:'pi_provider_error',message}}} as any);
 return o.forTerminal('turn',terminal);
}
describe('independent production classifier',()=>{
 for(const [name,text] of [['exact live 1',live1],['exact live 2',live2]]) it(name,()=>{const result=classify(text);console.log('JUDGE_CLASSIFIER',JSON.stringify({name,text,result}));expect(result?.errorCode).toBe('provider_policy_refusal');});
 for(const [name,text,answer] of [
 ['ordinary ToS account error','400 invalid_request_error: Your API key was rejected because your account has not accepted the Terms of Service.',false],
 ['ordinary ToS blocked account','400 invalid_request_error: Account blocked until Terms of Service are accepted.',false],
 ['reverse engineering answer','Reverse engineering requires authorization.',true],
 ['Connection refused','Connection refused',false],
 ['context-window error','400 invalid_request_error: context window exceeded',false],
 ['refusal in answer','I refuse this request under the usage policy.',true],
 ] as const) it(name,()=>{const result=classify(text,answer);console.log('JUDGE_CONTROL',JSON.stringify({name,text,answer,result}));expect(result).toBeNull();});
 it('note truthful for Terms of Service',()=>{const result=classify(live2);expect(result?.errorMessage).not.toContain('usage policy');});
});
