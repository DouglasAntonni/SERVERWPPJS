const { parse } = require('csv-parse');
const { MessageMedia } = require('whatsapp-web.js'); // Need MessageMedia here
const crypto = require('crypto'); // For bulk job ID

// Import utils directly as they are needed here too
const { formatWhatsappNumber, saveMessageToDb, updateMessageStatusAndId } = require('./utils');

// processCsvAndSendBulk now accepts optional image details
async function processCsvAndSendBulk(client, supabase, wss, csvBuffer, messageTemplate, imageBuffer = null, imageMimeType = null) {
    // Wrap the main logic in a Promise to handle async operations within the parser events
    return new Promise((resolve, reject) => {
        const records = [];
        const parser = parse({
            columns: true,
            skip_empty_lines: true,
            trim: true,
            on_record: (record, {lines}) => {
                const normalizedRecord = {};
                for (const key in record) {
                     normalizedRecord[key.trim().toLowerCase()] = record[key];
                }
                const name = normalizedRecord['nome'];
                const number = normalizedRecord['numero'];
                const cpf = normalizedRecord['cpf']; // Optional

                // Basic validation
                if (!name || !number) {
                     console.warn(`[Bulk CSV] Skipping record on line ${lines}: Missing 'Nome' or 'Numero'. Record:`, record);
                     return null; // Skip invalid record
                }
                // Validate phone number format (adjust regex if needed)
                if (!/^\+?[0-9]{10,}$/.test(number)) {
                     console.warn(`[Bulk CSV] Skipping record on line ${lines}: Invalid phone number format for ${number}. Record:`, record);
                     return null;
                 }
                 return { name: name, number: number, cpf: cpf || null }; // Return structured data
            }
        });

         parser.on('readable', function(){
             let record;
             while ((record = parser.read()) !== null) {
                 if (record) { // Only push valid records returned by on_record
                     records.push(record);
                 }
             }
         });

         parser.on('error', function(err){
             console.error("[Bulk CSV] Parsing Error:", err.message);
             wss.broadcast({ type: 'error', payload: `CSV Parsing Error: ${err.message}` });
             reject(new Error(`CSV Parsing Error: ${err.message}`)); // Reject the promise on parsing error
         });

         // Process records when parsing is complete
         parser.on('end', async function(){
             console.log(`[Bulk CSV] Parsed. ${records.length} valid records found.`);
             if (records.length === 0) {
                 console.warn("[Bulk CSV] No valid records found to send messages.");
                 wss.broadcast({ type: 'bulk_complete', payload: { total: 0, sent: 0, failed: 0 } }); // Notify frontend
                 resolve(); // Resolve the promise even if no records found
                 return;
             }

             let media = null;
             if (imageBuffer && imageMimeType) {
                 try {
                     // Use originalname 'image' if not available, though filename isn't crucial here
                     media = new MessageMedia(imageMimeType, imageBuffer.toString('base64'), 'image_bulk');
                     console.log("[Bulk Send] Image prepared for bulk sending.");
                 } catch (mediaError) {
                     console.error("[Bulk Send] Error creating MessageMedia for bulk send:", mediaError);
                     wss.broadcast({ type: 'error', payload: `Failed to process image for bulk send: ${mediaError.message}` });
                     // Stop bulk send if image processing fails
                     wss.broadcast({ type: 'bulk_complete', payload: { total: records.length, sent: 0, failed: records.length, error: 'Image processing failed' } });
                     reject(new Error('Failed to process image for bulk send')); // Reject promise
                     return;
                 }
             }

             // --- Start Bulk Sending Logic ---
             let sentCount = 0;
             let failCount = 0;
             const totalCount = records.length;
             const bulkJobId = crypto.randomUUID();
             const senderInfo = client.info; // Get sender info once

             console.log(`[Bulk Send] Starting job ${bulkJobId} for ${totalCount} messages...`);
             wss.broadcast({ // Initial progress update
                 type: 'bulk_progress',
                 payload: { current: 0, total: totalCount, success: 0, failed: 0 }
             });

             // Process each record sequentially with delays
             for (let i = 0; i < totalCount; i++) {
                 const record = records[i];
                 // Replace placeholder (case-insensitive)
                 const personalizedMessage = messageTemplate.replace(/\{nome\}/gi, record.name);
                 const recipientNumber = record.number;
                 const recipientId = formatWhatsappNumber(recipientNumber); // Ensure formatting

                 if (!recipientId) {
                     console.error(`[Bulk Send] (${i+1}/${totalCount}) Invalid recipient number format after format: ${recipientNumber}. Skipping.`);
                     failCount++;
                     // Save error state? Optional, depends on requirements. For now, just count failure.
                     wss.broadcast({
                         type: 'bulk_progress',
                         payload: { current: i + 1, total: totalCount, success: sentCount, failed: failCount }
                     });
                     continue; // Skip this record
                 }


                  // Delay between messages (e.g., random 1-4 seconds)
                  const delayMs = Math.random() * 3000 + 1000;
                  await new Promise(resolve => setTimeout(resolve, delayMs));

                  // 1. Save initial 'pending' record to DB
                  const dbMessage = await saveMessageToDb(supabase, senderInfo, wss, {
                      recipient_number: recipientNumber,
                      recipient_name: record.name, // Save name from CSV
                      body: personalizedMessage, // Caption or text message
                      status: 'pending',
                      is_outgoing: true,
                      bulk_job_id: bulkJobId,
                      has_media: !!media,
                      media_mime_type: media ? imageMimeType : null,
                      message_type: 'bulk' // Mark as bulk message
                  });

                  if (!dbMessage) {
                      console.error(`[Bulk Send] (${i+1}/${totalCount}) Failed to save initial DB record for ${recipientNumber}. Skipping message.`);
                      failCount++;
                      wss.broadcast({
                            type: 'bulk_progress',
                            payload: { current: i + 1, total: totalCount, success: sentCount, failed: failCount }
                       });
                      continue; // Skip sending if DB save failed
                  }

                 try {
                    let sentMessage;
                    if (media) {
                        // Send image with personalized caption
                        // Note: whatsapp-web.js might have limitations sending the *same* media object repeatedly quickly.
                        // If issues arise, creating a new MessageMedia object per send might be needed, but less efficient.
                        sentMessage = await client.sendMessage(recipientId, media, { caption: personalizedMessage });
                    } else {
                        // Send text message only
                        sentMessage = await client.sendMessage(recipientId, personalizedMessage);
                    }
                      console.log(`[Bulk Send] (${i+1}/${totalCount}) Message sent to ${record.name} (${recipientNumber}). WA ID: ${sentMessage.id.id}`);
                      sentCount++;
                      // 2. Update DB record with message ID and 'sent' status (ACK will update later)
                      await updateMessageStatusAndId(supabase, wss, dbMessage.id, sentMessage.id.id, 'sent');
                 } catch (error) {
                      console.error(`[Bulk Send] (${i+1}/${totalCount}) Failed to send message to ${record.name} (${recipientNumber}):`, error.message);
                      failCount++;
                       // 3. Update DB record with 'error' status and error message
                      await updateMessageStatusAndId(supabase, wss, dbMessage.id, null, 'error', error.message || 'Unknown sending error');
                 }

                 // Broadcast progress update after each attempt
                 wss.broadcast({
                     type: 'bulk_progress',
                     payload: { current: i + 1, total: totalCount, success: sentCount, failed: failCount }
                 });
             } // End of loop

             console.log(`[Bulk Send] Finished job ${bulkJobId}. Total: ${totalCount}, Sent: ${sentCount}, Failed: ${failCount}`);
              // Send final completion update
              wss.broadcast({
                  type: 'bulk_complete',
                  payload: { total: totalCount, sent: sentCount, failed: failCount, jobId: bulkJobId }
              });
              resolve(); // Resolve the promise when done
         }); // End of parser.on('end')

         // Start parsing the buffer
         parser.write(csvBuffer);
         parser.end();
    }); // End of Promise wrapper
}

// ** REMOVED formatWhatsappNumber, saveMessageToDb, updateMessageStatusAndId **
// ** They are now imported from ./utils.js **

module.exports = { processCsvAndSendBulk };