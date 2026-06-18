import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { RagModule } from './rag/rag.module';
import { TelegramModule } from './telegram/telegram.module';
import { LlmService } from './llm/llm.service'; // استيراد الخدمة مباشرة هنا

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, 
    }),
    RagModule,
    TelegramModule,
  ],
  controllers: [],
  providers: [PrismaService, LlmService], // تسجيل الـ LlmService كـ Provider عام
})
export class AppModule {}