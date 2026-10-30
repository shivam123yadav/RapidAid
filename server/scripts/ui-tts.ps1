# Generates the spoken test fixture for the headless UI recording flow.
# Chrome's --use-file-for-fake-audio-capture feeds this WAV as the "microphone".
Add-Type -AssemblyName System.Speech
$out = 'C:\Users\yashj\Downloads\workspace\server\scripts\ui-tts.wav'
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
$synth.SetOutputToWaveFile($out)
$synth.Speak('Accident near Rajwada Square in Indore. Two people are injured. Please send an ambulance.')
$synth.Dispose()
Get-Item $out | Select-Object Name, Length
