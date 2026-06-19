import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { RagService } from '../rag/rag.service';
import { PrismaService } from '../prisma.service';
import axios from 'axios';

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
        await this.mainBot.telegram.setWebhook(`${this.serverUrl}/telegram/main`);
        await this.adminBot.telegram.setWebhook(`${this.serverUrl}/telegram/admin`);
        console.log('🚀 Webhooks have been successfully configured!');
      } catch (error) {
        console.error('Error setting webhooks:', error);
      }
    }

    // تشغيل مستمعي الرسائل (Handlers)
    this.registerAdminBotHandlers();
    this.registerMainBotHandlers();
  }

  /**
   * 📥 1. بوت التغذية والإدارة (Admin Bot)
   */
  private registerAdminBotHandlers() {
    // عندما يقوم أحد المشرفين بإرسال خبر في جروب الإدارة المغلق
    this.adminBot.on('text', async (ctx) => {
      console.log("text comes to admin bot");
      const chatId = ctx.chat.id.toString();
      const text = ctx.message.text;

      // التأكد من أن الرسالة قادمة من جروب الإدارة المعتمد وليس من مكان آخر
      if (chatId === this.adminGroupChatId) {
        console.log('Received message in admin group:', text);
        // إذا بدأت الرسالة بكلمة "تغذية" أو "خبر:" نقوم بحفظها في الـ RAG
        if (text.startsWith('تغذية:') || text.startsWith('خبر:')) {
          const cleanContent = text.replace(/^(تغذية:|خبر:)\s*/, '');
          
          await ctx.reply('⏳ جاري معالجة الخبر وتحويله لـ Vector وحفظه في Neon...');
          try {
            await this.ragService.saveKnowledge(cleanContent);
            await ctx.reply('✅ تم حفظ المعلومة بنجاح في قاعدة بيانات ضاحية الفردوس والمزامنة مع الـ RAG!');
          } catch (error) {
            await ctx.reply('❌ حدث خطأ أثناء حفظ المعلومة، يرجى التحقق من السيرفر.');
          }
          return;
        }

        // آلية الرد اليدوي: إذا قام الأدمن بعمل Reply على استفسار محول من البوت الرئيسي
        if (ctx.message.reply_to_message) {
          const replyToId = ctx.message.reply_to_message.message_id.toString();

          // البحث عن التذكرة المعلقة المرتبطة بهذه الرسالة في قاعدة البيانات
          const ticket = await this.prisma.ticket.findFirst({
            where: { adminMsgId: replyToId, status: 'PENDING_MANUAL' },
          });

          if (ticket) {
            try {
              // إرسال رد الأدمن مباشرة للمستخدم الأصلي عبر البوت الرئيسي!
              await this.mainBot.telegram.sendMessage(ticket.chatId, `✍️ **رد من إدارة فريق الفردوس الإعلامي:**\n\n${text}`, { parse_mode: 'HTML' });
              
              // تحديث حالة التذكرة إلى تم الرد يدوياً
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
      }
    });
  }

  /**
   * 🤖 2. البوت الرئيسي للمستفسرين (Main Bot)
   */
  private registerMainBotHandlers() {
    // ترحيب بالمستخدم عند الضغط على /start
    this.mainBot.start(async (ctx) => {
      await ctx.reply(
        `أهلاً بك في بوت "فريق ضاحيتنا الإعلامي" لخدمة أهالي ضاحية الفردوس. 🌸\n\nاكتب استفسارك هنا (مثال: هل المياه مقطوعة اليوم؟) وسيقوم البوت الذكي بالإجابة عليك فوراً بناءً على أحدث البيانات المعتمدة لدينا.`,
      );
    });

    // معالجة استفسارات الأهالي سنقوم بربطها بالـ RAG والـ AI في المرحلة القادمة
    this.mainBot.on('text', async (ctx) => {
      console.log("text comes to main bot");
      const question = ctx.message.text;
      const chatId = ctx.chat.id.toString();
      const username = ctx.from.username || ctx.from.first_name;

      // 1. أرسل إشارة للمستخدم أن البوت مستيقظ ويعمل لكي لا يشعر بالبطء (Cold Start لـ Render)
      const waitingMsg = await ctx.reply('⏳ جاري البحث والتحقق من الاستفسار، لحظات من فضلك...');

      // 2. تسجيل التذكرة في قاعدة البيانات
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

      // [ملاحظة تذكيرية]: هنا في الخطوة القادمة سنقوم بإرسال الـ contextDocs إلى دالة الـ AI 
      // لتوليد الإجابة أو تحويلها للأدمن يدوياً إذا كانت المصفوفة فارغة.
      
      // مؤقتاً للتجربة: إذا لم يجد معلومات
      if (contextDocs.length === 0) {
        await this.mainBot.telegram.editMessageText(chatId, waitingMsg.message_id, undefined, '⏱️ لا توجد معلومات فورية حالياً، سيتم رفع استفسارك للمسؤولين والرد عليك فوراً.');
        
        // إرسال تنبيه لجروب الإدارة عبر بوت الإدارة
        const adminAlert = await this.adminBot.telegram.sendMessage(
          this.adminGroupChatId,
          `🚨 **إشعار استفسار جديد يحتاج رد يدوياً!**\n\n**المستفسر:** @${username}\n**الاستفسار:** ${question}\n\n👉 *قم بعمل Reply على هذه الرسالة للرد عليه مباشرة.*`,
          { parse_mode: 'HTML' }
        );

        // حفظ معرف الرسالة لربط الـ Reply لاحقاً
        await this.prisma.ticket.update({
          where: { id: ticket.id },
          data: { status: 'PENDING_MANUAL', adminMsgId: adminAlert.message_id.toString() },
        });
      } else {
        // إذا وجد معلومات (سنمررها للـ AI في الخطوة التالية، حالياً سنطبعها للتأكد من عمل الـ RAG)
        await this.mainBot.telegram.editMessageText(chatId, waitingMsg.message_id, undefined, `💡 **المعلومات المسترجعة من الـ RAG (تمهيداً لإرسالها للـ AI):**\n\n${contextDocs.join('\n')}`);
      }
    });
  }
}