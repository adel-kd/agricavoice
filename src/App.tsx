import { useState, useRef, useEffect, useCallback } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Volume2, Wheat, Loader2, Info } from 'lucide-react';

interface Message {
  role: 'user' | 'model';
  text: string;
}

interface StagedListing {
  cropType: string;
  quantity: number;
  unit: string;
  expectedPrice: number;
  location: string;
  harvestDate?: string;
}

const THRESHOLD = 5; // Volume threshold for VAD (0-255)
const SILENCE_DURATION = 1200; // 1.2 seconds of silence to trigger end

export default function App() {
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'connected'>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isUserSpeakingVAD, setIsUserSpeakingVAD] = useState(false);
  const [stagedListing, setStagedListing] = useState<StagedListing | null>(null);
  const [callDuration, setCallDuration] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  
  // Refs for state accessed inside animation frame
  const callStatusRef = useRef(callStatus);
  const isSpeakingRef = useRef(isSpeaking); // AI speaking
  const isMutedRef = useRef(isMuted);
  const isProcessingRef = useRef(isProcessing);
  const messagesRef = useRef(messages);

  useEffect(() => { callStatusRef.current = callStatus; }, [callStatus]);
  useEffect(() => { isSpeakingRef.current = isSpeaking; }, [isSpeaking]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Call Timer
  useEffect(() => {
    let timer: any;
    if (callStatus === 'connected') {
      timer = setInterval(() => setCallDuration(p => p + 1), 1000);
    } else {
      setCallDuration(0);
    }
    return () => clearInterval(timer);
  }, [callStatus]);

  useEffect(() => {
    return () => {
      endCall();
    };
  }, []);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const stopAudio = () => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.currentTime = 0;
      audioElRef.current.src = "";
      audioElRef.current = null;
    }
    setIsSpeaking(false);
  };

  const playAudio = async (base64Audio: string) => {
    stopAudio();
    try {
      const audio = new Audio("data:audio/mp3;base64," + base64Audio);
      audio.playbackRate = 1.15;
      audioElRef.current = audio;
      
      audio.onended = () => {
        setIsSpeaking(false);
      };
      
      setIsSpeaking(true);
      await audio.play();
    } catch (err) {
      console.error("Error playing audio", err);
      setIsSpeaking(false);
    }
  };

  const startCall = async () => {
    setCallStatus('calling');
    setIsProcessing(true);
    
    try {
      // 1. Get Microphone permissions
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = stream;
      
      // 2. Start VAD
      initVAD(stream);
      
      setCallStatus('connected');

      // 3. Get Greeting
      const response = await fetch('/api/start', { method: 'POST' });
      const data = await response.json();
      
      if (data.text) setMessages([{ role: 'model', text: data.text }]);
      if (data.audio) playAudio(data.audio);
      
    } catch (err) {
      console.error(err);
      alert("Please allow microphone access to make a call.");
      setCallStatus('idle');
    } finally {
      setIsProcessing(false);
    }
  };

  const endCall = () => {
    setCallStatus('idle');
    setIsProcessing(false);
    setIsSpeaking(false);
    setIsUserSpeakingVAD(false);
    setStagedListing(null);
    setMessages([]);
    stopAudio();
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
  };

  // --- Voice Activity Detection ---
  const initVAD = (stream: MediaStream) => {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioContextRef.current = audioContext;
    const analyser = audioContext.createAnalyser();
    analyser.minDecibels = -90;
    analyser.smoothingTimeConstant = 0.8;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    let isCurrentlySpeaking = false;
    let silenceTimer: any = null;
    let speakingTimer: any = null;

    const checkAudio = () => {
      if (!streamRef.current || streamRef.current.getTracks().length === 0) return;
      
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      let average = sum / dataArray.length;
      
      const currentThreshold = isSpeakingRef.current ? THRESHOLD + 1 : THRESHOLD;
      if (average > currentThreshold && !isMutedRef.current) {
        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
        if (!isCurrentlySpeaking && !isProcessingRef.current) {
          if (!speakingTimer) {
            speakingTimer = setTimeout(() => {
              isCurrentlySpeaking = true;
              setIsUserSpeakingVAD(true);
              onSpeechStart();
            }, 100); 
          }
        }
      } else {
        if (speakingTimer) {
          clearTimeout(speakingTimer);
          speakingTimer = null;
        }
        if (isCurrentlySpeaking && !silenceTimer) {
          silenceTimer = setTimeout(() => {
            isCurrentlySpeaking = false;
            setIsUserSpeakingVAD(false);
            onSpeechEnd();
          }, SILENCE_DURATION);
        }
      }
      requestAnimationFrame(checkAudio);
    };
    checkAudio();
  };

  const onSpeechStart = useCallback(() => {
    // Barge-in: If AI is speaking, interrupt it!
    if (isSpeakingRef.current) {
      stopAudio();
    }
    
    // Start recording if not already
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      try {
        const mediaRecorder = new MediaRecorder(streamRef.current!, { mimeType: 'audio/webm' });
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) audioChunksRef.current.push(event.data);
        };

        mediaRecorder.onstop = () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = async () => {
            const base64data = reader.result as string;
            const base64Audio = base64data.split(',')[1];
            await handleSendAudio(base64Audio);
          };
        };

        mediaRecorder.start();
      } catch (e) {
        console.error("Failed to start MediaRecorder", e);
      }
    }
  }, []);

  const onSpeechEnd = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsProcessing(true);
    }
  }, []);

  const handleSendAudio = async (base64Audio: string) => {
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioData: base64Audio, history: messagesRef.current })
      });
      
      const data = await response.json();
      
      if (data.ignore) {
        return;
      }
      
      if (data.stagedListing) {
        setStagedListing(data.stagedListing);
        const details = `[Staged Listing: ${data.stagedListing.cropType}, ${data.stagedListing.quantity}${data.stagedListing.unit}, ${data.stagedListing.expectedPrice}ETB]`;
        setMessages(prev => [...prev, { role: 'user', text: "🎤 (Audio Message)" }, { role: 'model', text: (data.text || "መረጃውን በስክሪኑ ላይ አዘጋጅቻለሁ") + " " + details }]);
      } else if (data.text) {
        setMessages(prev => [...prev, { role: 'user', text: "🎤 (Audio Message)" }, { role: 'model', text: data.text }]);
      }
      if (data.audio) {
        playAudio(data.audio);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  };

  const confirmListing = async () => {
    if (!stagedListing) return;
    try {
      setIsProcessing(true);
      
      fetch('/api/market/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stagedListing)
      }).catch(e => console.error("Background API error:", e));

      setStagedListing(null);
      const successText = "በአግባቡ ምርትዎ ገበያ ላይ ወጥቷል! የጥራት ባጅ ለማግኘት ወደ ዌብሳይት ፎቶ ያስገቡ";
      setMessages(prev => [...prev, { role: 'user', text: "Confirmed listing" }, { role: 'model', text: successText }]);
      
      try {
        const ttsRes = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: successText })
        });
        const ttsData = await ttsRes.json();
        if (ttsData.audio) {
          stopAudio();
          const audio = new Audio("data:audio/mp3;base64," + ttsData.audio);
          audio.playbackRate = 1.15;
          audioElRef.current = audio;
          setIsSpeaking(true);
          audio.onended = () => setIsSpeaking(false);
          await audio.play();
        }
      } catch (err) {
        console.error("TTS error on confirm:", err);
        await new Promise(r => setTimeout(r, 2000));
      }

      window.location.href = "https://agricaeth.netlify.app/market";
    } catch (e) {
      console.error(e);
      window.location.href = "https://agricaeth.netlify.app/market";
    } finally {
      setIsProcessing(false);
    }
  };

  const cancelListing = () => {
    setStagedListing(null);
    setMessages(prev => [...prev, { role: 'user', text: "Cancelled listing" }]);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center font-sans overflow-hidden relative">
      
      {/* Banner */}
      <div className="w-full bg-emerald-50 border-b border-emerald-200 p-3 text-center flex items-center justify-center gap-2 relative z-20">
        <Info className="w-4 h-4 text-emerald-600" />
        <p className="text-emerald-800 text-sm font-medium">
          The IVR is under development. Check out the demo here.
        </p>
      </div>

      {/* Main Content */}
      <div className="flex-1 w-full max-w-md mx-auto flex flex-col relative z-10">
        
        {callStatus === 'idle' ? (
          // --- IDLE / DIAL SCREEN ---
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="mb-12 flex flex-col items-center gap-6">
              <div className="w-24 h-24 rounded-full flex items-center justify-center shadow-[0_0_40px_rgba(16,185,129,0.3)] bg-white overflow-hidden p-2">
                <img src="https://res.cloudinary.com/ddntf1cdt/image/upload/v1783178561/image_numljs.png" alt="AgriCa Logo" className="w-full h-full object-contain" />
              </div>
              <div className="text-center">
                <h1 className="text-3xl font-display font-semibold text-gray-900 mb-2">AgriCa IVR Demo</h1>
                <p className="text-gray-500">AI Voice Assistant</p>
              </div>
            </div>

            <button
              onClick={startCall}
              className="group relative flex items-center justify-center w-20 h-20 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full transition-all shadow-[0_0_40px_rgba(16,185,129,0.4)] hover:shadow-[0_0_60px_rgba(16,185,129,0.6)] hover:-translate-y-1"
            >
              <Phone className="w-8 h-8 fill-current" />
            </button>
            <p className="mt-6 text-neutral-500 font-medium tracking-widest uppercase text-xs">Tap to Call</p>
          </div>
        ) : (
          // --- ACTIVE CALL SCREEN ---
          <div className="flex-1 flex flex-col items-center justify-between p-8 pb-12 w-full h-full">
            
            {/* Top section: Caller Info */}
            <div className="mt-8 flex flex-col items-center gap-4 w-full">
              <div className="relative">
                <div className={`w-24 h-24 rounded-full flex items-center justify-center bg-white z-10 relative transition-transform duration-300 overflow-hidden p-2 ${isSpeaking ? 'scale-105' : ''}`}>
                  <img src="https://res.cloudinary.com/ddntf1cdt/image/upload/v1783178561/image_numljs.png" alt="AgriCa Logo" className="w-full h-full object-contain" />
                </div>
                {/* Speaking Ring Animations */}
                {isSpeaking && (
                  <>
                    <div className="absolute inset-0 bg-emerald-500/30 rounded-full animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite]" />
                    <div className="absolute inset-0 bg-emerald-500/20 rounded-full animate-[ping_2.5s_cubic-bezier(0,0,0.2,1)_infinite_0.5s]" />
                  </>
                )}
              </div>
              
              <div className="text-center">
                <h2 className="text-2xl font-display font-medium text-gray-900 mb-1">AgriCa Assistant</h2>
                <p className="text-emerald-600 font-mono text-sm tracking-widest">
                  {callStatus === 'calling' ? 'Calling...' : formatTime(callDuration)}
                </p>
              </div>
            </div>

            {/* Middle section: Status & Staged Listing */}
            <div className="flex-1 flex flex-col items-center justify-center w-full my-8">
              {stagedListing ? (
                <div className="bg-white p-6 rounded-3xl w-full text-left shadow-2xl border border-emerald-100 animate-in fade-in slide-in-from-bottom-4">
                  <h3 className="text-lg text-gray-900 font-medium mb-4 text-center">Confirm Crop Listing</h3>
                  <div className="space-y-3 mb-6 text-sm">
                    <div className="flex justify-between border-b border-gray-100 pb-2">
                      <span className="text-gray-500">Crop</span>
                      <span className="text-gray-900 font-medium capitalize">{stagedListing.cropType}</span>
                    </div>
                    <div className="flex justify-between border-b border-gray-100 pb-2">
                      <span className="text-gray-500">Quantity</span>
                      <span className="text-gray-900 font-medium">{stagedListing.quantity} {stagedListing.unit}</span>
                    </div>
                    <div className="flex justify-between border-b border-gray-100 pb-2">
                      <span className="text-gray-500">Price</span>
                      <span className="text-gray-900 font-medium">{stagedListing.expectedPrice} ETB</span>
                    </div>
                    <div className="flex justify-between pb-1">
                      <span className="text-gray-500">Location</span>
                      <span className="text-gray-900 font-medium capitalize">{stagedListing.location}</span>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <button 
                      onClick={cancelListing} 
                      className="flex-1 py-3 px-4 rounded-2xl font-medium text-white bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={confirmListing} 
                      disabled={isProcessing}
                      className="flex-1 py-3 px-4 rounded-2xl font-medium text-white bg-emerald-600 hover:bg-emerald-500 transition-colors shadow-lg shadow-emerald-900/20 disabled:opacity-50"
                    >
                      {isProcessing ? "Adding..." : "Confirm"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  {isProcessing ? (
                    <div className="flex items-center gap-2 text-emerald-500/80 bg-emerald-500/10 px-4 py-2 rounded-full">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-xs font-medium tracking-wider uppercase">Processing...</span>
                    </div>
                  ) : isUserSpeakingVAD ? (
                    <div className="flex items-center gap-2 text-blue-400 bg-blue-500/10 px-4 py-2 rounded-full">
                      <div className="flex gap-1 h-3 items-center">
                        <div className="w-1 h-2 bg-blue-400 rounded-full animate-pulse" />
                        <div className="w-1 h-3 bg-blue-400 rounded-full animate-pulse delay-75" />
                        <div className="w-1 h-2 bg-blue-400 rounded-full animate-pulse delay-150" />
                      </div>
                      <span className="text-xs font-medium tracking-wider uppercase">Listening</span>
                    </div>
                  ) : isSpeaking ? (
                    <div className="flex items-center gap-2 text-emerald-600 bg-emerald-500/10 px-4 py-2 rounded-full">
                      <Volume2 className="w-4 h-4" />
                      <span className="text-xs font-medium tracking-wider uppercase">Speaking</span>
                    </div>
                  ) : (
                    <div className="px-4 py-2 opacity-0">Spacer</div>
                  )}
                </div>
              )}
            </div>

            {/* Bottom Controls */}
            <div className="w-full flex justify-center gap-8 items-center mt-auto">
              <button
                onClick={() => setIsMuted(!isMuted)}
                className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
                  isMuted 
                    ? 'bg-gray-900 text-white' 
                    : 'bg-gray-200 text-gray-900 hover:bg-gray-300'
                }`}
              >
                {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
              </button>

              <button
                onClick={endCall}
                className="w-20 h-20 bg-red-600 hover:bg-red-500 text-white rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(220,38,38,0.3)] transition-transform hover:-translate-y-1"
              >
                <PhoneOff className="w-8 h-8 fill-current" />
              </button>
            </div>
            
          </div>
        )}
      </div>
    </div>
  );
}
