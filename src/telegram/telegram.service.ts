import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { RagService } from '../rag/rag.service';
import { PrismaService } from '../prisma.service';
import axios from 'axios';
import { LlmService } from 'src/llm/llm.service';

@Injectable()
export class TelegramService implements OnModuleInit {
  public mainBot: Telegraf;
  public adminBot: Telegraf;

  private adminGroupChatId: string;
  private serverUrl: string;
  private sessionState = new Map<string, any>();
  private pendingServices = new Map<string, any>();

  constructor(
    private configService: ConfigService,
    private ragService: RagService,
    private prisma: PrismaService,
    private llmService: LlmService,
  ) {
    const mainToken = this.configService.get<string>('TELEGRAM_MAIN_BOT_TOKEN');
    const adminToken = this.configService.get<string>('TELEGRAM_ADMIN_BOT_TOKEN');
    this.adminGroupChatId = this.configService.get<string>('ADMIN_GROUP_CHAT_ID')!;
    this.serverUrl = this.configService.get<string>('SERVER_URL')!;

    if (!mainToken || !adminToken) {
      throw new Error('Telegram tokens are missing from .env');
    }

    this.mainBot = new Telegraf(mainToken);
    this.adminBot = new Telegraf(adminToken);
  }

  async onModuleInit() {
    console.log('Initializing TelegramService...');
    const envPolling = this.configService.get<string>('TELEGRAM_POLLING');
    const usePolling = envPolling === 'true' || !this.serverUrl || this.serverUrl.includes('localhost');
    console.log(usePolling);

    if (usePolling) {
      try {
        try { await this.mainBot.telegram.deleteWebhook(); } catch (e) { console.log('failed main bot'); }
        try { await this.adminBot.telegram.deleteWebhook(); } catch (e) { console.log('failed admin bot'); }
        await this.mainBot.launch();
        await this.adminBot.launch();
        console.log('🤖 Bots are running in Polling mode locally!');
      } catch (err) {
        console.error('Error launching bots in polling mode:', err);
      }
    } else {
      try {
        const webhookOptions: any = { allowed_updates: ['message', 'edited_message', 'callback_query', 'chat_member'], drop_pending_updates: true };
        await this.mainBot.telegram.setWebhook(`${this.serverUrl}/telegram/main`, webhookOptions);
        await this.adminBot.telegram.setWebhook(`${this.serverUrl}/telegram/admin`, webhookOptions);
        console.log('🚀 Webhooks have been successfully configured!');
      } catch (error) {
        console.error('Error setting webhooks:', error);
      }
    }

    this.registerAdminBotHandlers();
    this.registerMainBotHandlers();

    // reconcile pending tickets
    this.reconcilePendingTickets();
  }

  private async reconcilePendingTickets() {
    try {
      const pending = await this.prisma.ticket.findMany({ where: { status: { in: ['PENDING_BOT', 'PENDING_MANUAL'] } } });
      for (const t of pending) {
        try {
          if (t.status === 'PENDING_BOT') {
            const contextDocs = await this.ragService.searchKnowledge(t.question);
            const aiResponse = await this.llmService.generateResponse(t.question, contextDocs);
            if (aiResponse && !aiResponse.includes('I DONT KNOW')) {
              await this.mainBot.telegram.sendMessage(t.chatId, aiResponse);
              await this.prisma.ticket.update({ where: { id: t.id }, data: { status: 'ANSWERED_BY_BOT' } });
            } else {
              const adminAlert = await this.adminBot.telegram.sendMessage(this.adminGroupChatId, `🚨 Pending manual reply for ticket:\nUser: @${t.username}\nQuestion: ${t.question}`);
              if (adminAlert) await this.prisma.ticket.update({ where: { id: t.id }, data: { status: 'PENDING_MANUAL', adminMsgId: adminAlert.message_id.toString() } });
            }
          } else if (t.status === 'PENDING_MANUAL') {
            if (!t.adminMsgId) {
              const adminAlert = await this.adminBot.telegram.sendMessage(this.adminGroupChatId, `🚨 Pending manual reply for ticket:\nUser: @${t.username}\nQuestion: ${t.question}`);
              if (adminAlert) await this.prisma.ticket.update({ where: { id: t.id }, data: { adminMsgId: adminAlert.message_id.toString() } });
            }
          }
        } catch (err) {
          console.error('Error reconciling ticket', t.id, err?.message || err);
        }
      }
    } catch (err) {
      console.error('Failed to reconcile pending tickets:', err?.message || err);
    }
  }

  private registerAdminBotHandlers() {
    this.adminBot.on('text', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const text = ctx.message.text;
      const chatType = ctx.chat.type;

      const isAuthorizedGroup = chatId === this.adminGroupChatId || chatId.replace('-100', '') === this.adminGroupChatId.replace('-100', '');

      if (isAuthorizedGroup) {
        // save knowledge or quick responses
        if (text.startsWith('تغذية:') || text.startsWith('خبر:')) {
          const cleanContent = text.replace(/^(تغذية:|خبر:)\s*/, '');
          await ctx.reply('⏳ جاري معالجة الخبر وتحويله لـ Vector وحفظه في Neon...');
          try { await this.ragService.saveKnowledge(cleanContent); await ctx.reply('✅ تم حفظ المعلومة بنجاح'); } catch (err) { console.error(err); await ctx.reply('❌ حدث خطأ أثناء حفظ المعلومة'); }
          return;
        }

        if (text.startsWith('رد_ثابت:')) {
          const cleanText = text.replace('رد_ثابت:', '').trim();
          const parts = cleanText.split('->');
          if (parts.length < 2) { await ctx.reply('⚠️ صيغة خاطئة. استخدم: رد_ثابت: كلمة -> الرد'); return; }
          const keyword = parts[0].trim(); const replyText = parts[1].trim();
          try { await this.ragService.saveQuickResponse(keyword, replyText); await ctx.reply('✅ تم حفظ الرد الثابت'); } catch (err) { console.error(err); await ctx.reply('❌ فشل حفظ الرد'); }
          return;
        }

        // If replying to a ticket message -> send to user and update ticket
        if (ctx.message.reply_to_message) {
          const replyToId = ctx.message.reply_to_message.message_id.toString();
          const ticket = await this.prisma.ticket.findFirst({ where: { adminMsgId: replyToId, status: 'PENDING_MANUAL' } });
          if (ticket) {
            try { await this.mainBot.telegram.sendMessage(ticket.chatId, `✍️ رد من الإدارة:\n\n${text}`, { parse_mode: 'HTML' }); await this.prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'ANSWERED_MANUAL' } }); await ctx.reply('📥 تم إرسال ردك وتحديث حالة التذكرة.'); } catch (err) { await ctx.reply('❌ فشل إرسال الرسالة للمستخدم.'); }
            return;
          }

          // Approve pending service when admin replies 'ok'
          const pending = this.pendingServices.get(replyToId);
          if (pending && /ok/i.test(text)) {
            try {
              const saved = await this.ragService.saveServiceProvider(pending.data);
              await ctx.reply(`✅ تم اعتماد وحفظ الخدمة: ${saved.service} — ${saved.provider}`);
              await this.mainBot.telegram.sendMessage(pending.requesterChatId, `✅ تم اعتماد الخدمة التي أرسلتها: ${saved.service}`);
              this.pendingServices.delete(replyToId);
            } catch (err) {
              console.error('Failed saving approved service:', err);
              await ctx.reply('❌ فشل حفظ الخدمة عند محاولة الاعتماد.');
            }
            return;
          }
        }
      }

      // Private messages -> forward to GROQ endpoint if configured
      if (chatType === 'private') {
        const groqEndpoint = this.configService.get<string>('GROQ_ENDPOINT');
        if (!groqEndpoint) { await ctx.reply('🚫 GROQ endpoint غير مكوّن في السيرفر.'); return; }
        try {
          const resp = await axios.post(groqEndpoint, { content: text });
          await ctx.reply('✅ نُشرت مشاركتك عبر نظام النشر.');
          if (resp.data) await ctx.reply(JSON.stringify(resp.data).slice(0, 1000));
        } catch (err) {
          console.error('GROQ post failed:', err?.message || err);
          await ctx.reply('❌ فشل نشر المحتوى عبر GROQ.');
        }
      }
    });
  }

  private registerMainBotHandlers() {
    const opt1 = '1️⃣ سؤال عن شيء';
    const opt2 = '2️⃣ استفسار عن خدمة';
    const opt3 = '3️⃣ إضافة خدمة';
    const opt4 = '4️⃣ إرسال للنشر';

    this.mainBot.start(async (ctx) => {
      await ctx.reply(`أهلاً بك في بوت "فريق الفردوس الإعلامي". اختر أحد الخيارات أدناه:`, {
        reply_markup: { keyboard: [[{ text: opt1 }], [{ text: opt2 }], [{ text: opt3 }], [{ text: opt4 }]], resize_keyboard: true, one_time_keyboard: true },
      });
    });

    this.mainBot.on('text', async (ctx) => {
      const text = ctx.message.text.trim();
      const chatId = ctx.chat.id.toString();

      if (text === opt1) { this.sessionState.set(chatId, { type: 'ask_question' }); await ctx.reply('✍️ اكتب سؤالك الآن:'); return; }
      if (text === opt2) { this.sessionState.set(chatId, { type: 'service_search' }); await ctx.reply('🔎 ما اسم الخدمة التي تبحث عنها؟'); return; }
      if (text === opt3) { this.sessionState.set(chatId, { type: 'add_service', step: 1, data: {} }); await ctx.reply('🆕 حسناً، ما اسم الخدمة التي تريد إضافتها؟'); return; }
      if (text === opt4) { this.sessionState.set(chatId, { type: 'send_to_admin' }); await ctx.reply('📤 أرسل المحتوى الذي تريد إرساله للنشر في المجموعة الإدارية:'); return; }

      const state = this.sessionState.get(chatId);
      if (state) {
        if (state.type === 'ask_question') { this.sessionState.delete(chatId); await this.handleUserQuestion(ctx, text); return; }

        if (state.type === 'service_search') {
          this.sessionState.delete(chatId);
          const services = await this.ragService.searchServices(text);
          if (services.length === 0) {
            await ctx.reply('ℹ️ لم يتم العثور على خدمات مطابقة. هل ترغب في إرسال طلب إضافة لهذه الخدمة؟ اكتب "نعم" لإرسال طلب إضافة.');
            this.sessionState.set(chatId, { type: 'confirm_add_service', serviceName: text });
            return;
          }
          const lines = services.map(s => `• ${s.service} — ${s.provider}${s.phoneNumber ? ' — ' + s.phoneNumber : ''}${s.notes ? ' — ' + s.notes : ''}`);
          await ctx.reply(`📋 النتائج:\n${lines.join('\n')}`);
          return;
        }

        if (state.type === 'confirm_add_service') {
          this.sessionState.delete(chatId);
          if (/^نعم$/i.test(text)) { this.sessionState.set(chatId, { type: 'add_service', step: 1, data: { service: state.serviceName } }); await ctx.reply('🆕 بدء إضافة خدمة — ما اسم مقدم الخدمة؟'); return; }
          await ctx.reply('حسناً، تم إلغاء الطلب.'); return;
        }

        if (state.type === 'add_service') {
          if (state.step === 1) { if (!state.data.service) state.data.service = text; state.step = 2; this.sessionState.set(chatId, state); await ctx.reply('ما اسم مقدم الخدمة؟'); return; }
          if (state.step === 2) { state.data.provider = text; state.step = 3; this.sessionState.set(chatId, state); await ctx.reply('رقم الهاتف (أو اكتب "لا")؟'); return; }
          if (state.step === 3) { state.data.phoneNumber = /^لا$/i.test(text) ? '' : text; state.step = 4; this.sessionState.set(chatId, state); await ctx.reply('ملاحظات إضافية (أو اكتب "لا")'); return; }
          if (state.step === 4) {
            state.data.notes = /^لا$/i.test(text) ? '' : text;
            const adminMsgText = `🆕 طلب إضافة خدمة:\nالخدمة: ${state.data.service}\nالمقدم: ${state.data.provider}\nالهاتف: ${state.data.phoneNumber || 'غير متوفر'}\nملاحظات: ${state.data.notes || 'لا'}\n\nReply بـ 'ok' لاعتمادها.`;
            try {
              const adminAlert = await this.adminBot.telegram.sendMessage(this.adminGroupChatId, adminMsgText);
              if (adminAlert) { this.pendingServices.set(adminAlert.message_id.toString(), { requesterChatId: chatId, data: state.data }); await ctx.reply('تم إرسال طلب الإضافة للمجموعة الإدارية للمراجعة. سيتم إشعارك عند الاعتماد.'); }
              else await ctx.reply('فشل إرسال الطلب للمجموعة الإدارية. حاول لاحقاً.');
            } catch (err) { console.error('Failed to send admin alert', err); await ctx.reply('فشل إرسال الطلب للمجموعة.'); }
            this.sessionState.delete(chatId); return;
          }
        }

        if (state.type === 'send_to_admin') {
          this.sessionState.delete(chatId);
          try {
            const adminAlert = await this.adminBot.telegram.sendMessage(this.adminGroupChatId, `🔔 محتوى للنشر من المستخدم @${ctx.from.username || ctx.from.first_name}:\n\n${text}`);
            if (adminAlert) await ctx.reply('تم إرسال المحتوى للمجموعة الإدارية.'); else await ctx.reply('فشل إرسال المحتوى للمجموعة. حاول لاحقاً.');
          } catch (err) { console.error(err); await ctx.reply('فشل إرسال المحتوى.'); }
          return;
        }
      }

      // Default: treat as normal question
      await this.handleUserQuestion(ctx, text);
    });
  }

  private async handleUserQuestion(ctx: any, question: string) {
    const chatId = ctx.chat.id.toString();
    const username = ctx.from.username || ctx.from.first_name;
    try {
      const quickMatch = await this.ragService.searchQuickResponse(question);
      if (quickMatch) { await ctx.reply(quickMatch.reply); await this.prisma.ticket.create({ data: { chatId, username, question, status: 'ANSWERED_BY_BOT' } }); return; }

      const waitingMsg = await ctx.reply('⏳ جاري البحث والتحقق من الاستفسار، لحظات من فضلك...');
      const ticket = await this.prisma.ticket.create({ data: { chatId, username, question, status: 'PENDING_BOT' } });
      const contextDocs = await this.ragService.searchKnowledge(question);

      const validContextDocs = contextDocs.filter(doc => { if (!doc || doc.trim() === '') return false; const questionWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2); const matchCount = questionWords.filter(word => doc.toLowerCase().includes(word)).length; return matchCount > 0; });

      if (validContextDocs.length === 0) {
        const adminAlert = await this.adminBot.telegram.sendMessage(this.adminGroupChatId, `🚨 استفسار جديد يحتاج رد يدوي:\n👤 المستخدم: @${username}\n💬 السؤال: ${question}\n\n👉 قم بعمل Reply للرد عليه.`).catch(() => null);
        if (adminAlert) await this.prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'PENDING_MANUAL', adminMsgId: adminAlert.message_id.toString() } });
        await this.mainBot.telegram.editMessageText(chatId, waitingMsg.message_id, undefined, '⏱️ لا تتوفر تفاصيل فورية حالياً بخصوص هذا الاستفسار، تم تحويل سؤالك للمسؤولين وسيتم الرد عليك هنا فور صدور التوضيح.').catch(() => {});
        return;
      }

      const aiResponse = await this.llmService.generateResponse(question, contextDocs);
      if (aiResponse.includes('I DONT KNOW')) {
        const adminAlert = await this.adminBot.telegram.sendMessage(this.adminGroupChatId, `🚨 استفسار جديد يحتاج رد يدوي:\n👤 المستخدم: @${username}\n💬 السؤال: ${question}\n\n👉 قم بعمل Reply للرد عليه.`).catch(() => null);
        if (adminAlert) await this.prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'PENDING_MANUAL', adminMsgId: adminAlert.message_id.toString() } });
        await this.mainBot.telegram.editMessageText(chatId, waitingMsg.message_id, undefined, '⏱️ لا تتوفر تفاصيل فورية حالياً بخصوص هذا الاستفسار، تم تحويل سؤالك للمسؤولين وسيتم الرد عليك هنا فور صدور التوضيح.').catch(() => {});
        return;
      }

      await this.mainBot.telegram.editMessageText(chatId, waitingMsg.message_id, undefined, aiResponse);
      await this.prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'ANSWERED_BY_BOT' } });
    } catch (error) {
      console.error('Error processing main bot query:', error);
      try { await ctx.reply('⚠️ عذراً، واجهنا مشكلة فنية أثناء معالجة الطلب. يرجى المحاولة مرة أخرى لاحقاً.');
        console.log("ehhm: "+error);
       } catch (e) { console.error(e); }
    }
  }
}
