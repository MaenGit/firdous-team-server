import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { RagService } from '../rag/rag.service';
import { PrismaService } from '../prisma.service';
import axios from 'axios';
import { LlmService } from 'src/llm/llm.service';

@Injectable()
export class TelegramService implements OnModuleInit {
  // تعريف البوتين
  public mainBot: Telegraf;
  public adminBot: Telegraf;

  private adminGroupChatId: string;
  private serverUrl: string;

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

    // تهيئة كائنات التلغرام
    this.mainBot = new Telegraf(mainToken);
    this.adminBot = new Telegraf(adminToken);
  }

  async onModuleInit() {
    // إعداد الـ Webhooks عند إقلاع السيرفر وتوجيه التلغرام للروابط الخاصة بنا على Render
    if (this.serverUrl && !this.serverUrl.includes('localhost')) {
      try {
        const webhookOptions:any = {
          allowed_updates: ['message', 'edited_message', 'callback_query', 'chat_member'],
          drop_pending_updates: true // لتنظيف أي رسائل قديمة عالقة
        };
        await this.mainBot.telegram.setWebhook(`${this.serverUrl}/telegram/main`, webhookOptions);
        await this.adminBot.telegram.setWebhook(`${this.serverUrl}/telegram/admin`, webhookOptions);
        console.log('🚀 Webhooks have been successfully configured!');
      } catch (error) {
        console.error('Error setting webhooks:', error);
      }
    }

//     if (this.serverUrl && this.serverUrl.includes('localhost')) {
//   await this.mainBot.launch();
//   await this.adminBot.launch();
//   console.log('🤖 Bots are running in Polling mode locally!');
// }

    // تشغيل مستمعي الرسائل (Handlers)
    this.registerAdminBotHandlers();
    this.registerMainBotHandlers();
  }

  /**
   * 📥 1. بوت التغذية والإدارة (Admin Bot)
   */
  private registerAdminBotHandlers() {
    this.adminBot.on('text', async (ctx) => {
      console.log("=== 📥 رسالة جديدة وصلت لبوت الإدارة ===");
      
      const chatId = ctx.chat.id.toString();
      const text = ctx.message.text;
      const chatType = ctx.chat.type; // لمعرفة هل هي group أم supergroup أم private

      // 🚨 هذا السطر حاسم: سيطبع لك في الـ Logs الـ ID الدقيق للجروب الذي أرسلت فيه
      console.log(`[LOG] نوع المحادثة: ${chatType} | الـ ID المستلم: ${chatId} | النص: ${text}`);
      console.log(`[LOG] الـ ID المخزن في الـ .env الحالي هو: ${this.adminGroupChatId}`);

      // التحقق المرن: يقبل المطابقة المباشرة أو إذا كان أحدهما يحتوي على الآخر (بسبب الـ -100)
      const isAuthorizedGroup = 
        chatId === this.adminGroupChatId || 
        chatId.replace('-100', '') === this.adminGroupChatId.replace('-100', '');

      if (isAuthorizedGroup) {
        console.log('✅ تم التحقق بنجاح: الرسالة قادمة من جروب الإدارة المعتمد.');
        
        // إذا بدأت الرسالة بكلمة "تغذية" أو "خبر:" نقوم بحفظها في الـ RAG
        if (text.startsWith('تغذية:') || text.startsWith('خبر:')) {
          const cleanContent = text.replace(/^(تغذية:|خبر:)\s*/, '');
          
          await ctx.reply('⏳ جاري معالجة الخبر وتحويله لـ Vector وحفظه في Neon...');
          try {
            await this.ragService.saveKnowledge(cleanContent);
            await ctx.reply('✅ تم حفظ المعلومة بنجاح في قاعدة بيانات ضاحية الفردوس والمزامنة مع الـ RAG!');
          } catch (error) {
            console.error('Error saving knowledge:', error);
            await ctx.reply('❌ حدث خطأ أثناء حفظ المعلومة، يرجى التحقق من السيرفر.');
          }
          return;
        }

        if (text.startsWith('رد_ثابت:')) {
          const cleanText = text.replace('رد_ثابت:', '').trim();
          const parts = cleanText.split('->');

          if (parts.length < 2) {
            await ctx.reply('⚠️ الصيغة خاطئة يا صديقي! يرجى الكتابة بالشكل التالي:\n`رد_ثابت: السلام عليكم -> وعليكم السلام والرحمة`');
            return;
          }

          const keyword = parts[0].trim();
          const replyText = parts[1].trim();

          try {
            await this.ragService.saveQuickResponse(keyword, replyText);
            await ctx.reply(`✅ تم حفظ الرد الثابت بنجاح وتوليد الـ Vector الخاص به!`);
          } catch (error) {
            console.error('Error saving quick response:', error);
            await ctx.reply('❌ حدث خطأ أثناء حفظ الرد الثابت بقاعدة البيانات.');
          }
          return;
        }

        // آلية الرد اليدوي (Reply)
        if (ctx.message.reply_to_message) {
          const replyToId = ctx.message.reply_to_message.message_id.toString();

          const ticket = await this.prisma.ticket.findFirst({
            where: { adminMsgId: replyToId, status: 'PENDING_MANUAL' },
          });

          if (ticket) {
            try {
              await this.mainBot.telegram.sendMessage(ticket.chatId, `✍️ **رد من إدارة فريق الفردوس الإعلامي:**\n\n${text}`, { parse_mode: 'HTML' });
              
              await this.prisma.ticket.update({
                where: { id: ticket.id },
                data: { status: 'ANSWERED_MANUAL' },
              });

              await ctx.reply('📥 تم إرسال ردك يدوياً إلى صاحب الاستفسار بنجاح وتحديث حالة التذكرة.');
            } catch (err) {
              await ctx.reply('❌ فشل إرسال الرسالة للمستخدم، قد يكون قد قام بحظر البوت.');
            }
          }
        }
      } else {
        console.log('⚠️ تم رفض الرسالة لأن الـ Chat ID غير مطابق للـ ID المعتمد في الـ .env');
      }
    });
  }

  /**
   * 🤖 2. البوت الرئيسي للمستفسرين (Main Bot)
   */
  /**
   * 🤖 2. البوت الرئيسي للمستفسرين (Main Bot)
   */
  private registerMainBotHandlers() {
    // ترحيب بالمستخدم عند الضغط على /start
    this.mainBot.start(async (ctx) => {
      await ctx.reply(
        `أهلاً بك في بوت "فريق الفردوس الإعلامي" لخدمة أهالي ضاحية الفردوس. 🌸\n\nاكتب استفسارك هنا (مثال: هل المياه مقطوعة اليوم؟) وسيقوم البوت الذكي بالإجابة عليك فوراً بناءً على أحدث البيانات المعتمدة لدينا.`,
      );
    });

    // معالجة استفسارات الأهالي وربطها بالـ RAG والـ AI والردود الثابتة
    this.mainBot.on('text', async (ctx) => {
      console.log("text comes to main bot");
      const question = ctx.message.text.trim();
      const chatId = ctx.chat.id.toString();
      const username = ctx.from.username || ctx.from.first_name;

      try {
        // 🔍 1. خطوة الفحص السريع عن الردود الثابتة والمكررة
        // تأكد من مسمى جدول الردود الثابتة لديك سواء كان quickResponse أو quick_responses بحسب ما ظهر معك
        const quickMatch = await this.ragService.searchQuickResponse(question);

        // 🚀 إذا وجد رد ثابت، يرسله فوراً وينتهي الطلب هنا تماماً!
        if (quickMatch) {
          console.log(`🎯 [RAG QUICK MATCH] تم العثور على رد دلالي ثابت ومطابق.`);
          await ctx.reply(quickMatch.reply);
          
          await this.prisma.ticket.create({
            data: { chatId, username, question, status: 'ANSWERED_BY_BOT' },
          });
          return; // إنهاء ودفرة المحادثة بنجاح وتوفير الـ AI
        }

        // ⏳ 2. إذا لم يجد رداً ثابتاً، يكمل العمل الطبيعي للـ RAG والـ AI
        const waitingMsg = await ctx.reply('⏳ جاري البحث والتحقق من الاستفسار، لحظات من فضلك...');

        // تسجيل التذكرة في قاعدة البيانات لبدء المعالجة
        const ticket = await this.prisma.ticket.create({
          data: {
            chatId,
            username,
            question,
            status: 'PENDING_BOT',
          },
        });

        // 3. استدعاء نظام الـ RAG للبحث عن معلومات متعلقة بالسؤال
        const contextDocs = await this.ragService.searchKnowledge(question);
        console.log('🔍 [RAG RESULT] المخرجات الخام القادمة من الـ RAG هي:', JSON.stringify(contextDocs));

        // 🔥 فلترة إضافية: التأكد من أن النصوص المسترجعة ليست فارغة وتحتوي على حد أدنى من الكلمات المشتركة مع السؤال لمنع الهبد
        const validContextDocs = contextDocs.filter(doc => {
          if (!doc || doc.trim() === "") return false;
          
          // تفكيك الكلمات الأساسية في السؤال (تخطي حروف الجر القصيرة)
          const questionWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          
          // حساب كم كلمة من السؤال موجودة في الخبر المسترجع
          const matchCount = questionWords.filter(word => doc.toLowerCase().includes(word)).length;
          
          // شرط القرب النصي البديل: يجب أن يشترك الخبر مع السؤال في كلمة دلالية واحدة على الأقل
          return matchCount > 0;
        });

        // فحص صارم ومحدث: هل السياق بعد الفلترة وتطبيق شرط القرب أصبح فارغاً؟
        const isContextEmpty = validContextDocs.length === 0;

        // 4. إذا كان السياق فارغاً أو غير مرتبط وفقاً لشرط القرب -> تحويل فوري لجروب الإدارة
        if (isContextEmpty) {
          console.log('🚨 [LOG] لم يجتز أي خبر شرط القرب! جاري تحويل السؤال يدوياً إلى جروب الإدارة...');

          const adminAlert = await this.adminBot.telegram.sendMessage(
            this.adminGroupChatId,
            `🚨 استفسار جديد يحتاج رد يدوي:\n👤 المستخدم: @${username}\n💬 السؤال: ${question}\n\n👉 قم بعمل Reply للرد عليه.`
          ).catch(err => {
            console.error('❌ فشل الإرسال للمجموعة:', err.message);
            return null;
          });

          if (adminAlert) {
            await this.prisma.ticket.update({
              where: { id: ticket.id },
              data: { status: 'PENDING_MANUAL', adminMsgId: adminAlert.message_id.toString() },
            });
          }

          await this.mainBot.telegram.editMessageText(chatId, waitingMsg.message_id, undefined, '⏱️ لا تتوفر تفاصيل فورية حالياً بخصوص هذا الاستفسار، تم تحويل سؤالك للمسؤولين وسيتم الرد عليك هنا فور صدور التوضيح.').catch(e => {});
          return;
        }

        // 5. إذا وُجدت معلومات في قاعدة البيانات: نمرر المصفوفة للـ LLM (Gemini) ليصيغ الرد
        const aiResponse = await this.llmService.generateResponse(question, contextDocs);

        if (aiResponse == "I DONT KNOW"){
          console.log('🚨 [LOG] لم يجتز أي خبر شرط القرب! جاري تحويل السؤال يدوياً إلى جروب الإدارة...');

          const adminAlert = await this.adminBot.telegram.sendMessage(
            this.adminGroupChatId,
            `🚨 استفسار جديد يحتاج رد يدوي:\n👤 المستخدم: @${username}\n💬 السؤال: ${question}\n\n👉 قم بعمل Reply للرد عليه.`
          ).catch(err => {
            console.error('❌ فشل الإرسال للمجموعة:', err.message);
            return null;
          });

          if (adminAlert) {
            await this.prisma.ticket.update({
              where: { id: ticket.id },
              data: { status: 'PENDING_MANUAL', adminMsgId: adminAlert.message_id.toString() },
            });
          }

          await this.mainBot.telegram.editMessageText(chatId, waitingMsg.message_id, undefined, '⏱️ لا تتوفر تفاصيل فورية حالياً بخصوص هذا الاستفسار، تم تحويل سؤالك للمسؤولين وسيتم الرد عليك هنا فور صدور التوضيح.').catch(e => {});
          return;
        
        }

        // 6. تحديث رسالة الانتظار بالإجابة الذكية النهائية للمستخدم
        await this.mainBot.telegram.editMessageText(chatId, waitingMsg.message_id, undefined, aiResponse);

        // 7. تحديث حالة التذكرة في قاعدة البيانات إلى "تم الرد"
        await this.prisma.ticket.update({
          where: { id: ticket.id },
          data: { status: 'ANSWERED_BY_BOT' },
        });

      } catch (error) {
        console.error('Error processing main bot query:', error);
        try {
          // في حال حدوث أي خطأ، نبلغ المستخدم لكي لا يظل معلقاً
          await ctx.reply('⚠️ عذراً، واجهنا مشكلة فنية أثناء معالجة الطلب. يرجى المحاولة مرة أخرى لاحقاً.');
        } catch (ctxErr) {
          console.error('Could not send error message to user:', ctxErr);
        }
      }
    });
  }
}