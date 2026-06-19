import { Controller, Post, Req, Res } from '@nestjs/common';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  constructor(private telegramService: TelegramService) {}

  // 🤖 رابط البوت الرئيسي للمستفسرين
  @Post('main')
  async handleMainBot(@Req() req: any, @Res() res: any) {
    try {
      // نستخدم النوع any بشكل مؤقت لكسر صرامة المحرر وتمرير البيانات بأمان
      await this.telegramService.mainBot.handleUpdate(req.body, res);
      if (!res.headersSent) {
        res.sendStatus(200);
      }
    } catch (error) {
      console.error('Error handling Main Bot Update:', error);
      if (!res.headersSent) res.sendStatus(500);
    }
  }

  // 📥 رابط بوت التغذية والإدارة
  @Post('admin')
  async handleAdminBot(@Req() req: any, @Res() res: any) {
    try {
      console.log('📬 [RAW WEBHOOK] بيانات خام قادمة لبوت الإدارة:', JSON.stringify(req.body));

      await this.telegramService.adminBot.handleUpdate(req.body, res);
      if (!res.headersSent) {
        res.sendStatus(200);
      }
    } catch (error) {
      console.error('Error handling Admin Bot Update:', error);
      if (!res.headersSent) res.sendStatus(500);
    }
  }
}