// background.js
let aiSession = null;

async function initEngine() {
  try {
    if (typeof LanguageModel === 'undefined') return;
    aiSession = await LanguageModel.create({
      systemPrompt: "You are a social media feed filter. Respond with exactly '1' (slop/marketing/engagement bait) or '0' (authentic human/technical content). Never explain, never comment, never write words. Only a single digit."
    });
  } catch (err) {
    console.error("[SlopRadar] Engine init failed:", err);
  }
}

chrome.runtime.onInstalled.addListener(initEngine);
chrome.runtime.onStartup.addListener(initEngine);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "log") {
    console.log(request.text);
    return true;
  }

  if (request.action === "evaluatePost") {
    if (!aiSession) {
      sendResponse({ isSlop: false });
      return true;
    }

    const structuredPrompt = `Classify this post text. If it contains generic marketing, tech hype, engagement bait, corporate templates, space-maximizing short line breaks, narrative arcs like "the hard part", or robotic self promotion, classify as slop (1). If it is a raw technical insight, actual code, or genuine personal thought, classify as authentic (0). Be highly cynical and hyper-sensitive.

Input Text:
"""
${request.text}
"""

Classification (Respond with 1 or 0 only):`;

    aiSession.prompt(structuredPrompt)
      .then(result => {
        const rawOutput = result.trim();
        const matchedDigit = rawOutput.match(/[01]/)?.[0];
        const isSlop = matchedDigit === "1";
        
        console.log(`[SlopRadar Sync Log]\nINBOUND TEXT:\n"${request.text}"\n\nVERDICT: ${isSlop ? "AI SLOP" : "AUTHENTIC"}\nRAW MODEL OUTPUT: "${rawOutput}"`);
        sendResponse({ isSlop: isSlop });
      })
      .catch(err => {
        console.error("[SlopRadar] Inference error:", err);
        sendResponse({ isSlop: false });
      });
    
    return true; 
  }
});