const { createClient } = require('@supabase/supabase-js');

// Helper function to safely get client info
function getClientInfo(clientInstance) {
    if (clientInstance && clientInstance.info && clientInstance.info.wid) {
        return {
            number: clientInstance.info.wid._serialized, // e.g., '5511999999999@c.us'
            pushname: clientInstance.info.pushname // User's set profile name
            // Add other relevant info if needed
        };
    }
    return { number: null, pushname: null }; // Return nulls if info not available
}

function formatWhatsappNumber(number) {
    if (!number || typeof number !== 'string') return null;
    // Remove non-digit characters except '+' at the start
    let cleanedNumber = number.replace(/[^\d+]/g, '');
    // Remove leading '+' if present for suffix logic
    cleanedNumber = cleanedNumber.startsWith('+') ? cleanedNumber.substring(1) : cleanedNumber;

    // Basic length check (adjust as needed for different countries)
    if (cleanedNumber.length < 10) {
        console.warn(`Número formatado '${cleanedNumber}' parece curto demais.`);
        // return null; // Or handle as needed
    }

    // Add WhatsApp suffix
    return `${cleanedNumber}@c.us`;
}

// Updated to accept clientInfo object and message_type
async function saveMessageToDb(supabase, senderInfo, wss, details) {
     const messageData = {
         message_id: details.message_id || null, // Store WA message ID if available
         sender_number: details.is_outgoing ? senderInfo?.number : details.sender_number, // Use senderInfo if outgoing
         recipient_number: details.is_outgoing ? details.recipient_number : senderInfo?.number, // Use senderInfo if incoming recipient
         recipient_name: details.recipient_name || null, // Save name if provided
         body: details.body,
         is_outgoing: details.is_outgoing !== undefined ? details.is_outgoing : true, // Default to true if not specified
         status: details.status || 'pending', // Initial status
         bulk_job_id: details.bulk_job_id || null,
         error_message: details.error_message || null,
         timestamp: details.timestamp || new Date(), // Use WhatsApp timestamp if available, else now
         has_media: details.has_media || false,
         media_mime_type: details.media_mime_type || null,
         message_type: details.message_type || null // Add message type (incoming, auto_response, forwarded, manual_single, bulk)
         // Consider adding 'related_message_id' column in Supabase to link auto-responses/forwards to originals
         // related_message_id: details.related_message_id || null
     };
     try {
         const { data, error } = await supabase
             .from('messages')
             .insert(messageData)
             .select()
             .single();

         if (error) {
             console.error('Erro Supabase ao salvar mensagem:', error);
             // Avoid broadcasting sensitive error details to frontend
             // wss?.broadcast({ type: 'error', payload: `DB Save Error: ${error.message}` });
             return null;
         }
         // console.log('Mensagem salva no DB (ID:', data.id, 'Status:', messageData.status, ')');
         if (wss && typeof wss.broadcast === 'function') {
             // Ensure sensitive data isn't broadcast if not needed
             // For example, don't broadcast the full body of forwarded messages unless necessary
             const broadcastPayload = { ...data };
             // delete broadcastPayload.body; // Example: remove body before broadcasting if sensitive

             wss.broadcast({ type: 'new_message', payload: broadcastPayload }); // Notify frontend
         } else {
            // console.warn('Servidor WebSocket (wss) não fornecido ou inválido, não é possível transmitir new_message');
         }
         return data; // Return the saved message record (including its DB ID)
     } catch (dbError) {
         console.error('Erro ao inserir mensagem no Supabase:', dbError);
         return null;
     }
}

// Helper to update message ID and status in DB
async function updateMessageStatusAndId(supabase, wss, dbMessageId, messageId, status, errorMessage = null) {
    if (!dbMessageId) {
        // console.warn("Attempted to update message status without DB ID.");
        return;
    }

    try {
        const updateData = { status: status };
        if (messageId) {
            updateData.message_id = messageId; // Store/update the WhatsApp message ID
        }
        // Ensure error message is explicitly set or cleared
        // Only set error_message if status is 'error', otherwise clear it.
        updateData.error_message = (status === 'error' && errorMessage) ? errorMessage : null;


        const { data, error } = await supabase
            .from('messages')
            .update(updateData)
            .eq('id', dbMessageId)
            .select() // Select the updated row
            .single(); // Expect only one row

        if (error) {
            console.error(`Erro Supabase ao atualizar ID/status da mensagem para DB ID ${dbMessageId}:`, error);
        } else if (data) {
            // console.log(`Mensagem atualizada no DB (ID: ${dbMessageId}, WA ID: ${messageId || data.message_id || 'N/A'}, Status: ${status})`);
            if (wss && typeof wss.broadcast === 'function') {
                wss.broadcast({ type: 'message_update', payload: data }); // Notify frontend
            } else {
                 // console.warn('Servidor WebSocket (wss) não fornecido ou inválido, não é possível transmitir message_update');
            }
        } else {
             console.warn(`Nenhuma linha atualizada no DB para ID ${dbMessageId} com status ${status}. A mensagem existe?`);
        }
    } catch (dbError) {
        console.error(`Erro ao atualizar status/ID da mensagem no Supabase para DB ID ${dbMessageId}:`, dbError);
    }
}

module.exports = {
    getClientInfo, // Export the new helper
    formatWhatsappNumber,
    saveMessageToDb,
    updateMessageStatusAndId
};