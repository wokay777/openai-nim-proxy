if (stream) {
      // Handle streaming response with reasoning
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
