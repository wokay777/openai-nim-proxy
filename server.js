// server.js - OpenAI to NVIDIA NIM API Proxy (UPDATED VERSION)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = true; // Set to true to show reasoning with <think> tags

// 🔥 THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = true; // Set to true to enable chat_template_kwargs thinking parameter

// Model mapping (adjust based on available NIM models)
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'deepseek-r1': 'deepseek-ai/deepseek-r1-0528',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',  // Try with period first
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking' 
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy', 
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // Smart model selection with fallback
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      try {
        await axios.post(`${NIM_API_BASE}/chat/completions`, {
          model: model,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1
        }, {
          headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
          validateStatus: (status) => status < 500
        }).then(res => {
          if (res.status >= 200 && res.status < 300) {
            nimModel = model;
          }
        });
      } catch (e) {}
      
      if (!nimModel) {
        const modelLower = model.toLowerCase();
        if (modelLower.includes('gpt-4') || modelLower.includes('claude-opus') || modelLower.includes('405b')) {
          nimModel = 'meta/llama-3.1-405b-instruct';
        } else if (modelLower.includes('claude') || modelLower.includes('gemini') || modelLower.includes('70b')) {
          nimModel = 'meta/llama-3.1-70b-instruct';
        } else {
          nimModel = 'meta/llama-3.1-8b-instruct';
        }
      }
    }
    
    // Transform OpenAI request to NIM format
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 1,
      top_p: 0.95,
      max_tokens: max_tokens || 8192,
      stream: stream || false
    };
    
    // Add thinking mode if enabled (at top level, not in extra_body)
    if (ENABLE_THINKING_MODE) {
      nimRequest.chat_template_kwargs = { thinking: true };
    }
    
    // Log the request for debugging
    console.log('Sending to NVIDIA:', JSON.stringify({
      model: nimRequest.model,
      has_thinking: !!nimRequest.chat_template_kwargs,
      stream: nimRequest.stream
    }));
    
    // Make request to NVIDIA NIM API
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    if (stream) {
      // Handle streaming response with reasoning (IMPROVED VERSION)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      
      let buffer = '';
      let reasoningStarted = false;
      let hasStarted = false;
      
      response.data.on('data', (chunk) => {
        try {
          if (!hasStarted) {
            hasStarted = true;
            res.flushHeaders(); // Force headers to send immediately
          }
          
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          lines.forEach(line => {
            if (!line.trim()) return;
            
            if (line.startsWith('data: ')) {
              if (line.includes('[DONE]')) {
                res.write('data: [DONE]\n\n');
                return;
              }
              
              try {
                const data = JSON.parse(line.slice(6));
                if (data.choices?.[0]?.delta) {
                  const reasoning = data.choices[0].delta.reasoning_content;
                  const content = data.choices[0].delta.content;
                  
                  if (SHOW_REASONING) {
                    let combinedContent = '';
                    
                    if (reasoning && !reasoningStarted) {
                      combinedContent = '<think>\n' + reasoning;
                      reasoningStarted = true;
                    } else if (reasoning) {
                      combinedContent = reasoning;
                    }
                    
                    if (content && reasoningStarted) {
                      combinedContent += '\n</think>\n\n' + content;
                      reasoningStarted = false;
                    } else if (content) {
                      combinedContent += content;
                    }
                    
                    if (combinedContent) {
                      data.choices[0].delta.content = combinedContent;
                      delete data.choices[0].delta.reasoning_content;
                    }
                  } else {
                    // When not showing reasoning, only send actual content
                    if (content) {
                      data.choices[0].delta.content = content;
                    } else {
                      data.choices[0].delta.content = '';
                    }
                    delete data.choices[0].delta.reasoning_content;
                  }
                }
                
                const output = `data: ${JSON.stringify(data)}\n\n`;
                res.write(output);
              } catch (e) {
                // If JSON parse fails, just pass through
                res.write(line + '\n\n');
              }
            }
          });
        } catch (err) {
          console.error('Stream processing error:', err);
        }
      });
      
      response.data.on('end', () => {
        if (reasoningStarted) {
          // Close unclosed thinking tag
          res.write('data: {"choices":[{"delta":{"content":"\\n</think>"}}]}\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
      
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.write(`data: {"error": "${err.message}"}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    } else {
      // Transform NIM response to OpenAI format with reasoning
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + fullContent;
          }
          
          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: fullContent
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    console.error('Error details:', error.response?.data || 'No response data');
    console.error('Status code:', error.response?.status);
    
    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.detail || error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500,
        nvidia_error: error.response?.data
      }
    });
  }
});

// Catch-all for unsupported endpoints
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
});
