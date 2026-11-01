import asyncio
import json
import os
import wave
import miniaudio
import edge_tts

FIXTURES = [
    {
        "id": "en_us_medical_cardiac",
        "category": "English emergency report",
        "voice": "en-US-GuyNeural",
        "language": "en",
        "reference_text": "Emergency. An elderly man collapsed and is unconscious with severe chest pain near City Center. Please send an ambulance immediately.",
        "expected_incident": "CARDIAC_ARREST",
        "expected_location": "City Center",
        "key_terms": ["unconscious", "chest pain", "collapsed", "ambulance"],
    },
    {
        "id": "en_in_accident_maharaj_bada",
        "category": "Indian-accented English vehicle accident (Gwalior)",
        "voice": "en-IN-PrabhatNeural",
        "language": "en",
        "reference_text": "There has been a severe vehicle accident at Maharaj Bada in Gwalior. A motorcycle collided with a car and two people are badly injured. Send an ambulance quickly.",
        "expected_incident": "VEHICLE_COLLISION",
        "expected_location": "Maharaj Bada, Gwalior",
        "key_terms": ["vehicle accident", "collided", "injured", "Maharaj Bada"],
    },
    {
        "id": "en_in_medical_phool_bagh",
        "category": "Indian-accented English medical emergency (Gwalior)",
        "voice": "en-IN-NeerjaNeural",
        "language": "en",
        "reference_text": "Urgent medical help needed near Phool Bagh crossing in Gwalior. A person is bleeding heavily after a head injury. Please dispatch emergency services right away.",
        "expected_incident": "TRAUMA",
        "expected_location": "Phool Bagh crossing, Gwalior",
        "key_terms": ["bleeding heavily", "head injury", "emergency services", "Phool Bagh"],
    },
    {
        "id": "en_in_accident_hazira_chowk",
        "category": "Indian-accented English vehicle accident (Gwalior)",
        "voice": "en-IN-PrabhatNeural",
        "language": "en",
        "reference_text": "Accident near Hazira Chowk in Gwalior. An auto-rickshaw overturned and the driver is trapped. We need immediate rescue.",
        "expected_incident": "VEHICLE_COLLISION",
        "expected_location": "Hazira Chowk, Gwalior",
        "key_terms": ["accident", "overturned", "trapped", "rescue", "Hazira Chowk"],
    },
    {
        "id": "hi_in_accident_gwalior",
        "category": "Hindi emergency report (Gwalior vehicle accident)",
        "voice": "hi-IN-MadhurNeural",
        "language": "hi",
        "reference_text": "नमस्ते, महाराज बाड़ा ग्वालियर में एक गंभीर सड़क दुर्घटना हुई है। दो लोग घायल हैं और तुरंत एम्बुलेंस भेजिए।",
        "expected_incident": "VEHICLE_COLLISION",
        "expected_location": "महाराज बाड़ा ग्वालियर",
        "key_terms": ["सड़क दुर्घटना", "घायल", "एम्बुलेंस", "महाराज बाड़ा"],
    },
    {
        "id": "hi_in_medical_deendayal_nagar",
        "category": "Hindi emergency report (Gwalior medical emergency)",
        "voice": "hi-IN-SwaraNeural",
        "language": "hi",
        "reference_text": "दीनदयाल नगर ग्वालियर में एक व्यक्ति को दिल का दौरा पड़ा है और वह बेहोश है। सांस लेने में बहुत तकलीफ हो रही है, जल्दी डॉक्टर और एम्बुलेंस भेजिए।",
        "expected_incident": "CARDIAC_ARREST",
        "expected_location": "दीनदयाल नगर ग्वालियर",
        "key_terms": ["दिल का दौरा", "बेहोश", "सांस लेने में तकलीफ", "दीनदयाल नगर"],
    },
    {
        "id": "hi_in_accident_morar",
        "category": "Hindi emergency report (Gwalior Morar collision)",
        "voice": "hi-IN-MadhurNeural",
        "language": "hi",
        "reference_text": "मुरार चौराहा पर एक बस और कार की टक्कर हो गई है। कई यात्री घायल हैं, तुरंत पुलिस और एम्बुलेंस की जरूरत है।",
        "expected_incident": "VEHICLE_COLLISION",
        "expected_location": "मुरार चौराहा",
        "key_terms": ["टक्कर", "घायल", "एम्बुलेंस", "मुरार चौराहा"],
    },
]

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "fixtures", "speech")
os.makedirs(OUT_DIR, exist_ok=True)


async def main():
    metadata = []
    for f in FIXTURES:
        fid = f["id"]
        mp3_path = os.path.join(OUT_DIR, f"{fid}.mp3")
        wav_path = os.path.join(OUT_DIR, f"{fid}.wav")
        print(f"Generating {fid} using voice {f['voice']}...")
        comm = edge_tts.Communicate(f["reference_text"], f["voice"])
        await comm.save(mp3_path)
        dec = miniaudio.decode_file(mp3_path, sample_rate=16000, nchannels=1)
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(dec.samples)
        if os.path.exists(mp3_path):
            os.remove(mp3_path)
        duration_s = round(len(dec.samples) / 16000, 2)
        size_bytes = os.path.getsize(wav_path)
        print(f"  -> {fid}.wav ready: {duration_s}s, {size_bytes} bytes")
        metadata.append(
            {
                **f,
                "file": f"{fid}.wav",
                "duration_seconds": duration_s,
                "size_bytes": size_bytes,
                "sample_rate": 16000,
                "channels": 1,
            }
        )

    json_path = os.path.join(OUT_DIR, "benchmark-manifest.json")
    with open(json_path, "w", encoding="utf-8") as jf:
        json.dump(metadata, jf, indent=2, ensure_ascii=False)
    print(f"\nManifest written to {json_path}")


if __name__ == "__main__":
    asyncio.run(main())
