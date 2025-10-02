const express = require('express');
const Airtable = require('airtable');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 3000;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const KLING_API_KEY = process.env.KLING_API_KEY;

// Initialize Airtable
const base = new Airtable({ apiKey: AIRTABLE_TOKEN }).base(AIRTABLE_BASE_ID);

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        service: 'Kling Video Generation',
        timestamp: new Date().toISOString()
    });
});

// Main video generation endpoint
app.post('/generate-video', async (req, res) => {
    const { recordId } = req.body;
    
    if (!recordId) {
        return res.status(400).json({ error: 'recordId is required' });
    }

    console.log('='.repeat(60));
    console.log('Starting video generation for record:', recordId);
    console.log('Time:', new Date().toISOString());
    
    // Respond immediately to Airtable (prevent timeout)
    res.json({ 
        success: true, 
        message: 'Video generation started',
        recordId: recordId
    });

    // Continue processing in background
    try {
        // Fetch record from Airtable
        console.log('Fetching record from Airtable...');
        const record = await base('video_generation').find(recordId);
        
        const inputImage = record.fields.input_image?.[0]?.url;
        const customPrompt = record.fields.custom_prompt;
        const presetPrompt = record.fields.preset_prompt;
        const duration = record.fields.duration || 5;
        const aspectRatio = record.fields.aspect_ratio || 'auto';
        
        const prompt = customPrompt || presetPrompt;
        
        console.log('Record details:');
        console.log('- Duration:', duration);
        console.log('- Aspect ratio:', aspectRatio);
        console.log('- Prompt:', prompt?.substring(0, 100) + '...');
        
        // Validation
        if (!inputImage) {
            console.error('ERROR: No input image found');
            await base('video_generation').update(recordId, {
                status: 'Failed',
                error_log: 'No input image found'
            });
            return;
        }
        
        if (!prompt) {
            console.error('ERROR: No prompt provided');
            await base('video_generation').update(recordId, {
                status: 'Failed',
                error_log: 'No prompt provided (neither custom nor preset)'
            });
            return;
        }

        // Update status to Generating
        console.log('Updating status to Generating...');
        await base('video_generation').update(recordId, {
            status: 'Generating',
            error_log: 'Submitting job to Kling API...'
        });

        // Submit to Kling API
        console.log('Submitting to Kling API...');
        const submitResponse = await fetch('https://api.wavespeed.ai/api/v3/kwaivgi/kling-v2.5-turbo-pro/image-to-video', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${KLING_API_KEY}`
            },
            body: JSON.stringify({
                duration: duration.toString(),
                guidance_scale: 0.5,
                image: inputImage,
                prompt: prompt
            })
        });

        if (!submitResponse.ok) {
            const errorText = await submitResponse.text();
            console.error('Submit failed:', submitResponse.status, errorText);
            await base('video_generation').update(recordId, {
                status: 'Failed',
                error_log: `API submission failed: ${errorText}`
            });
            return;
        }

        const submitData = await submitResponse.json();
        const jobId = submitData.data.id;
        
        console.log('Job submitted successfully!');
        console.log('Job ID:', jobId);
        
        // Save job ID to Airtable
        await base('video_generation').update(recordId, {
            job_id: jobId,
            error_log: 'Job submitted. Video is generating...'
        });

        // Poll for completion
        console.log('Starting polling loop...');
        let attempts = 0;
        const maxAttempts = 80; // ~6.5 minutes max
        let videoUrl = null;

        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
            attempts++;

            const elapsedTime = attempts * 5;
            console.log(`Polling attempt ${attempts}/${maxAttempts} (${elapsedTime}s elapsed)`);

            try {
                const statusResponse = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${jobId}/result`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${KLING_API_KEY}`
                    }
                });

                if (!statusResponse.ok) {
                    console.warn('Status check failed:', statusResponse.status);
                    continue;
                }

                const statusResult = await statusResponse.json();
                const status = statusResult.data.status;

                console.log('Current status:', status);

                // Update progress in Airtable every 10 attempts
                if (attempts % 10 === 0) {
                    await base('video_generation').update(recordId, {
                        error_log: `Generating... ${elapsedTime}s elapsed (status: ${status})`
                    });
                }

                if (status === 'completed') {
                    videoUrl = statusResult.data.outputs[0];
                    console.log('Video completed!');
                    console.log('Video URL:', videoUrl);
                    break;
                } else if (status === 'failed') {
                    const errorMsg = statusResult.data.error || 'Generation failed';
                    console.error('Generation failed:', errorMsg);
                    await base('video_generation').update(recordId, {
                        status: 'Failed',
                        error_log: `Kling AI error: ${errorMsg}`
                    });
                    return;
                }
                // Otherwise continue polling
            } catch (pollError) {
                console.error('Polling error:', pollError.message);
                // Continue polling despite errors
            }
        }

        if (!videoUrl) {
            console.error('TIMEOUT: Video not ready after', maxAttempts * 5, 'seconds');
            await base('video_generation').update(recordId, {
                status: 'Failed',
                error_log: `Video generation timed out after ${maxAttempts * 5} seconds (~${Math.round(maxAttempts * 5 / 60)} minutes)`
            });
            return;
        }

        // Download and upload video to Airtable
        console.log('Downloading video...');
        const videoResponse = await fetch(videoUrl);
        
        if (!videoResponse.ok) {
            console.error('Download failed:', videoResponse.status);
            // Save URL as fallback
            await base('video_generation').update(recordId, {
                status: 'Completed (URL only)',
                video_url: videoUrl,
                error_log: 'Video ready but Airtable upload failed. Download from video_url field.'
            });
            return;
        }

        const videoSize = parseInt(videoResponse.headers.get('content-length') || '0');
        const videoSizeMB = (videoSize / 1024 / 1024).toFixed(2);
        console.log('Video downloaded. Size:', videoSizeMB, 'MB');

        // Upload to Airtable
        console.log('Uploading to Airtable...');
        const filename = `video_${duration}s_${aspectRatio.replace(':', 'x')}_${jobId.substring(0, 8)}.mp4`;
        
        await base('video_generation').update(recordId, {
            status: 'Completed',
            output_video: [{
                url: videoUrl,
                filename: filename
            }],
            video_url: videoUrl,
            error_log: '✅ Video generation completed successfully!'
        });

        console.log('SUCCESS! Video uploaded to Airtable');
        console.log('Filename:', filename);
        console.log('='.repeat(60));

    } catch (error) {
        console.error('CRITICAL ERROR:', error);
        console.error('Stack trace:', error.stack);
        
        try {
            await base('video_generation').update(recordId, {
                status: 'Failed',
                error_log: `Server error: ${error.message}`
            });
        } catch (updateError) {
            console.error('Failed to update Airtable with error:', updateError.message);
        }
    }
});

// Start server
app.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('Kling Video Generation Server');
    console.log('='.repeat(60));
    console.log('Status: ONLINE');
    console.log('Port:', PORT);
    console.log('Time:', new Date().toISOString());
    console.log('='.repeat(60));
});

module.exports = app;
