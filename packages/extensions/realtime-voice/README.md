# @step-harness/realtime-voice

The replaceable realtime-voice device extension for step-harness (S6-2): microphone
capture, speaker playback, and the vendor/transport bridge, implementing the neutral
`RealtimeDriver` contract from `@step-harness/realtime`. It imports only
`@step-harness/realtime`, registers nothing itself, and is registered by the composition
root only when a voice surface is selected — so a normal (coding) startup never loads an
audio SDK or opens the microphone. First phase ships a **mock driver**
(`createRealtimeVoiceDriver()`); the real audio SDK / ASR / TTS are chosen when voice is
actually built.
